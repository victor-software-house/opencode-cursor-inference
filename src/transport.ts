import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from 'node:http2';
import { connect } from 'node:http2';
import { gzipSync } from 'node:zlib';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
	CONNECT_FLAG_COMPRESSED,
	CONNECT_MAX_FRAME_BYTES,
	ConnectFrameDecoder,
	encodeConnectFrame,
} from '@cursor/connect';
import type {
	InferenceStreamRequest,
	RunInferenceClientMessage,
	RunInferenceInvocationEnd,
	RunInferenceInvocationError,
	RunInferenceRunReady,
	RunInferenceServerMessage,
} from '@cursor/gen/aiserver/v1/inference_pb';
import {
	RunInferenceCancelInvocationSchema,
	RunInferenceClientMessageSchema,
	RunInferenceFinishRunSchema,
	RunInferenceInvokeModelSchema,
	RunInferenceServerMessageSchema,
} from '@cursor/gen/aiserver/v1/inference_pb';
import { inferenceRequestHeaders } from '@cursor/headers';
import type { CursorMachineIdentity } from '@cursor/identity';
import { isRecord, omitUndefined } from '@victor-software-house/pi-type-kit';

const CONNECT_COMPRESSION_MIN_BYTES = 1_024;
const RESPONSE_TIMEOUT_MS = 65_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_PENDING_INVOCATIONS = 64;
const MAX_QUEUED_RESPONSE_MESSAGES = 512;
const MAX_QUEUED_RESPONSE_BYTES = 8 * 1024 * 1024;

interface ConnectTrailer {
	readonly error?: {
		readonly code: string;
		readonly message?: string;
	};
}

export interface CursorInferenceRuntimeOptions {
	readonly backendUrl: string;
	readonly token: string;
	readonly ghostMode: boolean;
	readonly identity: CursorMachineIdentity;
	readonly connect?: (authority: string | URL) => ClientHttp2Session | Promise<ClientHttp2Session>;
	readonly responseTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly createRequestId?: () => string;
	readonly createClientKey?: () => string;
	readonly now?: () => number;
	readonly timezone?: () => string;
}

export interface CursorInferenceInvokeOptions {
	readonly signal?: AbortSignal;
	readonly onResponse: (message: RunInferenceServerMessage) => void | Promise<void>;
}

export interface CursorInferenceInvocation {
	readonly invocationId: string;
	readonly end: RunInferenceInvocationEnd;
}

interface PendingInvocation {
	readonly onResponse: CursorInferenceInvokeOptions['onResponse'];
	readonly resolve: (value: CursorInferenceInvocation) => void;
	readonly reject: (error: unknown) => void;
	readonly signal: AbortSignal | undefined;
	readonly abort: () => void;
	delivery: Promise<void>;
}

interface RunCompletion {
	readonly trailer: ConnectTrailer;
}

function randomHex(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

function validateBackendUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error('Cursor backend authority is invalid', { cause: error });
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		(url.pathname !== '' && url.pathname !== '/') ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new Error('Cursor backend authority must be an HTTPS origin');
	}
	return new URL(url.origin);
}

function encodeClientMessage(message: RunInferenceClientMessage): Uint8Array {
	const protobufBody = toBinary(RunInferenceClientMessageSchema, message);
	if (protobufBody.byteLength > CONNECT_MAX_FRAME_BYTES) {
		throw new Error('Cursor RunInference client message exceeds the Connect frame limit');
	}
	return protobufBody.byteLength < CONNECT_COMPRESSION_MIN_BYTES
		? encodeConnectFrame(protobufBody)
		: encodeConnectFrame(gzipSync(protobufBody), CONNECT_FLAG_COMPRESSED);
}

function parseTrailer(body: Uint8Array): ConnectTrailer {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(body));
	} catch (error) {
		throw new Error('Cursor returned an invalid Connect end-of-stream trailer', { cause: error });
	}
	if (!isRecord(raw)) throw new Error('Cursor returned an invalid Connect end-of-stream trailer');
	if (raw['error'] === undefined) return {};
	if (!isRecord(raw['error']) || typeof raw['error']['code'] !== 'string') {
		throw new Error('Cursor returned an invalid Connect error trailer');
	}
	const code = raw['error']['code'].trim();
	const message = raw['error']['message'];
	if (code === '' || (message !== undefined && typeof message !== 'string')) {
		throw new Error('Cursor returned an invalid Connect error trailer');
	}
	return { error: omitUndefined({ code, message }) };
}

export function cursorInvocationErrorMessage(error: RunInferenceInvocationError): string {
	return error.message.trim() === ''
		? `Cursor invocation error ${String(error.code)}`
		: error.message;
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				return resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				return reject(error);
			},
		);
	});
}

export class CursorInferenceRun {
	readonly routeKey: string;
	readonly connection: ClientHttp2Session;
	readonly ready: Promise<RunInferenceRunReady>;
	readonly completion: Promise<RunCompletion>;
	readonly #request: ClientHttp2Stream;
	readonly #pending = new Map<string, PendingInvocation>();
	readonly #cancelled = new Set<string>();
	readonly #responseTimeoutMs: number;
	readonly #resolveReady: (value: RunInferenceRunReady) => void;
	readonly #rejectReady: (error: unknown) => void;
	readonly #resolveCompletion: (value: RunCompletion) => void;
	readonly #rejectCompletion: (error: unknown) => void;
	#writeQueue = Promise.resolve();
	#deliveryQueue = Promise.resolve();
	#queuedDeliveryMessages = 0;
	#queuedDeliveryBytes = 0;
	#runReady: RunInferenceRunReady | undefined;
	#trailer: ConnectTrailer | undefined;
	#failed: unknown;
	readonly #lifecycle = new Set<'finishing'>();

	constructor(
		session: ClientHttp2Session,
		routeKey: string,
		headers: Record<string, string>,
		options: Pick<CursorInferenceRuntimeOptions, 'responseTimeoutMs'>,
	) {
		this.routeKey = routeKey;
		this.connection = session;
		this.#responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
		let resolveReady!: (value: RunInferenceRunReady) => void;
		let rejectReady!: (error: unknown) => void;
		this.ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		void this.ready.catch(() => undefined);
		this.#resolveReady = resolveReady;
		this.#rejectReady = rejectReady;
		let resolveCompletion!: (value: RunCompletion) => void;
		let rejectCompletion!: (error: unknown) => void;
		this.completion = new Promise((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		void this.completion.catch(() => undefined);
		this.#resolveCompletion = resolveCompletion;
		this.#rejectCompletion = rejectCompletion;
		this.#request = session.request(headers);
		this.#bindResponse();
	}

	#bindResponse(): void {
		const decoder = new ConnectFrameDecoder();
		let status = 0;
		this.#request.on('response', (headers: IncomingHttpHeaders) => {
			status = Number(headers[':status'] ?? 0);
			if (status !== 200) {
				this.#fail(new Error(`Cursor RunInference returned HTTP ${String(status)}`));
				return;
			}
			const contentType = headers['content-type'] ?? '';
			if (!contentType.startsWith('application/connect+proto')) {
				this.#fail(new Error('Cursor RunInference returned an invalid content type'));
			}
		});
		this.#request.on('data', (chunk: Uint8Array) => {
			try {
				for (const frame of decoder.push(chunk)) {
					if (this.#trailer !== undefined)
						throw new Error('Cursor sent data after the Connect trailer');
					if (frame.endOfStream) {
						this.#trailer = parseTrailer(frame.body);
						if (this.#trailer.error !== undefined) {
							throw new Error(
								`Cursor RunInference failed: ${this.#trailer.error.code}${
									this.#trailer.error.message === undefined
										? ''
										: ` — ${this.#trailer.error.message}`
								}`,
							);
						}
						continue;
					}
					const message = fromBinary(RunInferenceServerMessageSchema, frame.body);
					this.#queuedDeliveryMessages += 1;
					this.#queuedDeliveryBytes += frame.body.byteLength;
					if (
						this.#queuedDeliveryMessages > MAX_QUEUED_RESPONSE_MESSAGES ||
						this.#queuedDeliveryBytes > MAX_QUEUED_RESPONSE_BYTES
					) {
						throw new Error('Cursor RunInference response delivery exceeded its bound');
					}
					this.#deliveryQueue = this.#deliveryQueue.then(async () => {
						try {
							await this.#handle(message);
							return undefined;
						} finally {
							this.#queuedDeliveryMessages -= 1;
							this.#queuedDeliveryBytes -= frame.body.byteLength;
						}
					});
					void this.#deliveryQueue.catch((error: unknown) => {
						this.#fail(error);
					});
				}
			} catch (error) {
				this.#fail(error);
			}
		});
		this.#request.on('error', (error) => this.#fail(error));
		this.#request.on('aborted', () => this.#fail(new Error('Cursor RunInference stream aborted')));
		this.#request.on('end', () => {
			try {
				decoder.end();
			} catch (error) {
				this.#fail(error);
				return;
			}
			void this.#deliveryQueue.then(() => {
				if (this.#failed !== undefined) return undefined;
				if (status !== 200) return undefined;
				if (this.#trailer === undefined) {
					this.#fail(new Error('Cursor RunInference ended without a Connect trailer'));
					return undefined;
				}
				if (this.#pending.size > 0) {
					this.#fail(new Error('Cursor RunInference ended with pending invocations'));
					return undefined;
				}
				this.#resolveCompletion({ trailer: this.#trailer });
				return undefined;
			});
		});
	}

	async #handle(message: RunInferenceServerMessage): Promise<void> {
		switch (message.message.case) {
			case 'heartbeat':
				return;
			case 'runReady':
				if (this.#runReady !== undefined) throw new Error('Cursor sent duplicate runReady');
				if (
					message.message.value.resolvedModel === undefined ||
					message.message.value.resolvedModel.modelId === ''
				) {
					throw new Error('Cursor runReady has no resolved model');
				}
				this.#runReady = message.message.value;
				this.#resolveReady(message.message.value);
				return;
			case 'invocationResponse': {
				const { invocationId } = message.message.value;
				if (this.#cancelled.has(invocationId)) return;
				const pending = this.#pending.get(invocationId);
				if (pending === undefined)
					throw new Error(`Cursor response has unknown invocation '${invocationId}'`);
				pending.delivery = pending.delivery.then(async () => await pending.onResponse(message));
				await pending.delivery;
				return;
			}
			case 'invocationEnd': {
				const end = message.message.value;
				if (this.#cancelled.delete(end.invocationId)) return;
				const pending = this.#pending.get(end.invocationId);
				if (pending === undefined)
					throw new Error(`Cursor ended unknown invocation '${end.invocationId}'`);
				this.#pending.delete(end.invocationId);
				pending.signal?.removeEventListener('abort', pending.abort);
				await pending.delivery;
				if (end.error === undefined) pending.resolve({ invocationId: end.invocationId, end });
				else
					pending.reject(
						new Error(`Cursor invocation failed: ${cursorInvocationErrorMessage(end.error)}`),
					);
				return;
			}
			case undefined:
				throw new Error('Cursor RunInference server message has no arm');
		}
	}

	#fail(error: unknown): void {
		if (this.#failed !== undefined) return;
		this.#failed = error;
		this.#rejectReady(error);
		for (const pending of this.#pending.values()) {
			pending.signal?.removeEventListener('abort', pending.abort);
			pending.reject(error);
		}
		this.#pending.clear();
		this.#rejectCompletion(error);
		this.#request.destroy(error instanceof Error ? error : new Error(String(error)));
	}

	async send(message: RunInferenceClientMessage): Promise<void> {
		if (this.#failed !== undefined) throw this.#failed;
		const frame = encodeClientMessage(message);
		this.#writeQueue = this.#writeQueue.then(
			async () =>
				await new Promise<void>((resolve, reject) => {
					this.#request.write(frame, (error?: Error | null) => {
						if (error === undefined || error === null) resolve();
						else reject(error);
					});
				}),
		);
		await this.#writeQueue;
	}

	async waitUntilReady(): Promise<RunInferenceRunReady> {
		return await waitWithTimeout(this.ready, this.#responseTimeoutMs, 'Cursor runReady');
	}

	abort(error: unknown): void {
		this.#fail(error);
	}

	async invoke(
		invocationId: string,
		request: InferenceStreamRequest,
		options: CursorInferenceInvokeOptions,
	): Promise<CursorInferenceInvocation> {
		if (this.#lifecycle.has('finishing')) throw new Error('Cursor RunInference run is finishing');
		await this.waitUntilReady();
		if (this.#pending.size >= MAX_PENDING_INVOCATIONS) {
			throw new Error('Cursor RunInference has too many pending invocations');
		}
		if (this.#pending.has(invocationId) || this.#cancelled.has(invocationId)) {
			throw new Error(`Cursor invocation '${invocationId}' already exists`);
		}
		let resolve!: (value: CursorInferenceInvocation) => void;
		let reject!: (error: unknown) => void;
		const result = new Promise<CursorInferenceInvocation>((accept, fail) => {
			resolve = accept;
			reject = fail;
		});
		const abort = (): void => {
			const pending = this.#pending.get(invocationId);
			if (pending === undefined) return;
			this.#pending.delete(invocationId);
			this.#cancelled.add(invocationId);
			void this.send(
				create(RunInferenceClientMessageSchema, {
					message: {
						case: 'cancelInvocation',
						value: create(RunInferenceCancelInvocationSchema, { invocationId }),
					},
				}),
			).then(
				() => reject(new DOMException('Aborted', 'AbortError')),
				(error: unknown) => {
					reject(error);
					this.#fail(error);
				},
			);
		};
		this.#pending.set(invocationId, {
			onResponse: options.onResponse,
			resolve,
			reject,
			signal: options.signal,
			abort,
			delivery: Promise.resolve(),
		});
		if (options.signal?.aborted === true) abort();
		else options.signal?.addEventListener('abort', abort, { once: true });
		if (this.#cancelled.has(invocationId)) return await result;
		try {
			await this.send(
				create(RunInferenceClientMessageSchema, {
					message: {
						case: 'invokeModel',
						value: create(RunInferenceInvokeModelSchema, { invocationId, request }),
					},
				}),
			);
		} catch (error) {
			this.#pending.delete(invocationId);
			options.signal?.removeEventListener('abort', abort);
			reject(error);
		}
		return await result;
	}

	async finish(timeoutMs: number): Promise<void> {
		if (this.#lifecycle.has('finishing')) {
			await waitWithTimeout(this.completion, timeoutMs, 'Cursor RunInference shutdown');
			return;
		}
		this.#lifecycle.add('finishing');
		for (const [invocationId, pending] of this.#pending) {
			this.#pending.delete(invocationId);
			this.#cancelled.add(invocationId);
			pending.signal?.removeEventListener('abort', pending.abort);
			pending.reject(new Error('Cursor RunInference closed before invocation completed'));
			await this.send(
				create(RunInferenceClientMessageSchema, {
					message: {
						case: 'cancelInvocation',
						value: create(RunInferenceCancelInvocationSchema, { invocationId }),
					},
				}),
			);
		}
		await this.send(
			create(RunInferenceClientMessageSchema, {
				message: { case: 'finishRun', value: create(RunInferenceFinishRunSchema) },
			}),
		);
		this.#request.end();
		await waitWithTimeout(this.completion, timeoutMs, 'Cursor RunInference shutdown');
	}
}

interface RunSlot {
	readonly routeKey: string;
	readonly run: CursorInferenceRun;
}

/** One account-scoped managed-inference runtime with routed runs isolated by OpenCode session id. */
export class CursorInferenceRuntime {
	readonly #options: CursorInferenceRuntimeOptions;
	readonly #backend: URL;
	readonly #clientKey: string;
	readonly #runs = new Map<string, RunSlot>();
	readonly #runLocks = new Map<string, Promise<void>>();
	readonly #sessions = new Set<ClientHttp2Session>();
	#session: ClientHttp2Session | undefined;
	#sessionPromise: Promise<ClientHttp2Session> | undefined;
	readonly #lifecycle = new Set<'closed'>();

	constructor(options: CursorInferenceRuntimeOptions) {
		this.#backend = validateBackendUrl(options.backendUrl);
		this.#options = options;
		this.#clientKey = (options.createClientKey ?? (() => randomHex(32)))();
		if (!/^[0-9a-f]{64}$/u.test(this.#clientKey)) {
			throw new Error('Cursor client key must be 32-byte lowercase hex');
		}
	}

	async #getSession(): Promise<ClientHttp2Session> {
		if (this.#lifecycle.has('closed'))
			throw new Error('Cursor managed-inference runtime is shut down');
		if (this.#session !== undefined && !this.#session.destroyed && !this.#session.closed) {
			return this.#session;
		}
		this.#sessionPromise ??= Promise.resolve(
			(this.#options.connect ?? ((authority) => connect(authority)))(this.#backend.origin),
		)
			.catch((error: unknown) => {
				this.#sessionPromise = undefined;
				throw error;
			})
			.then((session) => {
				this.#session = session;
				this.#sessions.add(session);
				this.#sessionPromise = undefined;
				session.once('goaway', () => {
					if (this.#session === session) this.#session = undefined;
				});
				session.on('error', () => {
					if (this.#session === session) this.#session = undefined;
				});
				session.once('close', () => {
					if (this.#session === session) this.#session = undefined;
					this.#sessions.delete(session);
				});
				return session;
			});
		return await this.#sessionPromise;
	}

	async #retireConnection(run: CursorInferenceRun): Promise<void> {
		const connection = run.connection;
		if (this.#session === connection) this.#session = undefined;
		const stillUsed = [...this.#runs.values()].some((slot) => slot.run.connection === connection);
		if (stillUsed || connection.closed || connection.destroyed) return;
		await new Promise<void>((resolve) => {
			connection.once('close', resolve);
			connection.close();
		});
	}

	async #newRun(
		routeKey: string,
		runRequest: RunInferenceClientMessage,
	): Promise<CursorInferenceRun> {
		const requestId = (this.#options.createRequestId ?? (() => crypto.randomUUID()))();
		const headers = inferenceRequestHeaders({
			token: this.#options.token,
			ghostMode: this.#options.ghostMode,
			identity: this.#options.identity,
			requestId,
			clientKey: this.#clientKey,
			nowMs: (this.#options.now ?? Date.now)(),
			timezone: (
				this.#options.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone)
			)(),
		});
		const run = new CursorInferenceRun(await this.#getSession(), routeKey, headers, this.#options);
		try {
			await run.send(runRequest);
			await run.waitUntilReady();
			return run;
		} catch (error) {
			run.abort(error);
			throw error;
		}
	}

	async runFor(
		sessionId: string,
		routeKey: string,
		runRequest: RunInferenceClientMessage,
	): Promise<CursorInferenceRun> {
		if (sessionId === '')
			throw new Error('Cursor managed inference requires a stable OpenCode session id');
		const previous = this.#runLocks.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lock = previous.then(async () => await current);
		this.#runLocks.set(sessionId, lock);
		await previous;
		try {
			const slot = this.#runs.get(sessionId);
			if (slot?.routeKey === routeKey) return slot.run;
			if (slot !== undefined) {
				this.#runs.delete(sessionId);
				await slot.run.finish(this.#options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
				await this.#retireConnection(slot.run);
			}
			const run = await this.#newRun(routeKey, runRequest);
			this.#runs.set(sessionId, { routeKey, run });
			const removeRun = (): void => {
				const active = this.#runs.get(sessionId);
				if (active?.run === run) this.#runs.delete(sessionId);
			};
			void run.completion.then(removeRun, removeRun);
			return run;
		} finally {
			release();
			if (this.#runLocks.get(sessionId) === lock) this.#runLocks.delete(sessionId);
		}
	}

	async invoke(
		sessionId: string,
		routeKey: string,
		runRequest: RunInferenceClientMessage,
		invocationId: string,
		request: InferenceStreamRequest,
		options: CursorInferenceInvokeOptions,
	): Promise<CursorInferenceInvocation> {
		const run = await this.runFor(sessionId, routeKey, runRequest);
		return await run.invoke(invocationId, request, options);
	}

	async finishSession(sessionId: string): Promise<void> {
		const slot = this.#runs.get(sessionId);
		if (slot === undefined) return;
		this.#runs.delete(sessionId);
		await slot.run.finish(this.#options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
	}

	async shutdown(): Promise<void> {
		if (this.#lifecycle.has('closed')) return;
		this.#lifecycle.add('closed');
		const runs = [...this.#runs.values()];
		this.#runs.clear();
		await Promise.allSettled(
			runs.map(
				async ({ run }) => await run.finish(this.#options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS),
			),
		);
		for (const session of this.#sessions) session.destroy();
		this.#sessions.clear();
		this.#session = undefined;
	}
}
