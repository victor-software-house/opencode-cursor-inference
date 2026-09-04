import { afterEach, describe, expect, test } from 'bun:test';
import type { Http2Server, ServerHttp2Session, ServerHttp2Stream } from 'node:http2';
import { connect, createServer } from 'node:http2';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { CONNECT_FLAG_END_STREAM, ConnectFrameDecoder, encodeConnectFrame } from '@cursor/connect';
import {
	InferenceRequestedModelSchema,
	InferenceStreamRequestSchema,
	InferenceStreamResponseSchema,
	InferenceTextStreamPartSchema,
	RunInferenceClientMessageSchema,
	RunInferenceInvocationEndSchema,
	RunInferenceInvocationResponseSchema,
	RunInferenceRunReadySchema,
	RunInferenceRunRequestSchema,
	RunInferenceServerMessageSchema,
} from '@cursor/gen/aiserver/v1/inference_pb';
import { CursorInferenceRuntime } from '@cursor/transport';

const IDENTITY = {
	machineId: '1'.repeat(64),
	macMachineId: '2'.repeat(64),
	machineIdSource: 'host',
} as const;
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_KEY = 'b'.repeat(64);
const NOW = 1_788_307_200_000;

let server: Http2Server | undefined;
const sessions = new Set<ServerHttp2Session>();

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return await promise.then(
		() => {
			throw new Error('expected promise to reject');
		},
		(error: unknown) => error,
	);
}

async function waitForUnhandledRejectionTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await Bun.sleep(1);
}

afterEach(() => {
	for (const session of sessions) session.destroy();
	sessions.clear();
	server?.close();
	server = undefined;
});

function serverMessage(
	message: Parameters<typeof create<typeof RunInferenceServerMessageSchema>>[1],
) {
	return create(RunInferenceServerMessageSchema, message);
}

function clientRun() {
	return create(RunInferenceClientMessageSchema, {
		message: {
			case: 'runRequest',
			value: create(RunInferenceRunRequestSchema, {
				conversationId: 'pi-session',
				requestedModel: create(InferenceRequestedModelSchema, { modelId: 'composer-2.5' }),
				agentMode: 'agent',
			}),
		},
	});
}

function textResponse(invocationId: string, text: string) {
	return serverMessage({
		message: {
			case: 'invocationResponse',
			value: create(RunInferenceInvocationResponseSchema, {
				invocationId,
				response: create(InferenceStreamResponseSchema, {
					response: {
						case: 'textPart',
						value: create(InferenceTextStreamPartSchema, { text }),
					},
				}),
			}),
		},
	});
}

function invocationEnd(invocationId: string) {
	return serverMessage({
		message: {
			case: 'invocationEnd',
			value: create(RunInferenceInvocationEndSchema, { invocationId }),
		},
	});
}

function send(stream: ServerHttp2Stream, message: ReturnType<typeof serverMessage>): void {
	stream.write(encodeConnectFrame(toBinary(RunInferenceServerMessageSchema, message)));
}

async function loopback(
	onMessage: (
		message: ReturnType<typeof fromBinary<typeof RunInferenceClientMessageSchema>>,
		stream: ServerHttp2Stream,
	) => void,
) {
	let capturedHeaders: Record<string, string> | undefined;
	server = createServer();
	server.on('session', (session) => sessions.add(session));
	server.on('stream', (stream: ServerHttp2Stream, headers) => {
		capturedHeaders = Object.fromEntries(
			Object.entries(headers).map(([name, value]) => [name, String(value)]),
		);
		stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
		const decoder = new ConnectFrameDecoder();
		stream.on('data', (chunk: Uint8Array) => {
			for (const frame of decoder.push(chunk)) {
				onMessage(fromBinary(RunInferenceClientMessageSchema, frame.body), stream);
			}
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('loopback has no port');
	return {
		origin: `http://127.0.0.1:${String(address.port)}`,
		headers: () => capturedHeaders,
	};
}

function runtime(target: { readonly origin: string }) {
	return new CursorInferenceRuntime({
		backendUrl: 'https://api2.cursor.sh',
		token: 'HEADER.PAYLOAD.SIGNATURE',
		ghostMode: false,
		identity: IDENTITY,
		connect: () => connect(target.origin),
		createRequestId: () => REQUEST_ID,
		createClientKey: () => CLIENT_KEY,
		now: () => NOW,
		timezone: () => 'America/Sao_Paulo',
	});
}

describe('managed inference transport', () => {
	test('handles ready rejection when transport fails before waitUntilReady', async () => {
		server = createServer();
		server.on('session', (session) => {
			sessions.add(session);
			session.destroy(new Error('setup transport failure'));
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('loopback has no port');
		const managed = runtime({ origin: `http://127.0.0.1:${String(address.port)}` });
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);
		try {
			await rejection(
				managed.invoke(
					'pi-session',
					'route',
					clientRun(),
					'invocation',
					create(InferenceStreamRequestSchema),
					{ onResponse: () => undefined },
				),
			);
			await waitForUnhandledRejectionTurn();
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			await managed.shutdown();
		}
	});

	test('handles completion rejection when setup fails before runReady', async () => {
		server = createServer();
		server.on('session', (session) => sessions.add(session));
		server.on('stream', (stream: ServerHttp2Stream) => {
			stream.respond({ ':status': 500, 'content-type': 'application/connect+proto' });
			stream.end();
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('loopback has no port');
		const managed = runtime({ origin: `http://127.0.0.1:${String(address.port)}` });
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);
		try {
			const failure = await rejection(
				managed.invoke(
					'pi-session',
					'route',
					clientRun(),
					'invocation',
					create(InferenceStreamRequestSchema),
					{ onResponse: () => undefined },
				),
			);
			expect(failure).toHaveProperty('message', 'Cursor RunInference returned HTTP 500');
			await waitForUnhandledRejectionTurn();
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			await managed.shutdown();
		}
	});

	test('retries after an HTTP/2 connection promise rejects', async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case === 'runRequest') {
				send(
					stream,
					serverMessage({
						message: {
							case: 'runReady',
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, {
									modelId: 'composer-2.5',
								}),
							}),
						},
					}),
				);
			}
			if (message.message.case === 'invokeModel') {
				send(stream, invocationEnd(message.message.value.invocationId));
			}
			if (message.message.case === 'finishRun') {
				stream.end(encodeConnectFrame(new TextEncoder().encode('{}'), CONNECT_FLAG_END_STREAM));
			}
		});
		let attempts = 0;
		const managed = new CursorInferenceRuntime({
			backendUrl: 'https://api2.cursor.sh',
			token: 'HEADER.PAYLOAD.SIGNATURE',
			ghostMode: false,
			identity: IDENTITY,
			connect: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('temporary connect failure');
				return connect(target.origin);
			},
			createRequestId: () => REQUEST_ID,
			createClientKey: () => CLIENT_KEY,
		});
		const request = create(InferenceStreamRequestSchema);
		const first = await rejection(
			managed.invoke('pi-session', 'route', clientRun(), 'first', request, {
				onResponse: () => undefined,
			}),
		);
		expect(first).toHaveProperty('message', 'temporary connect failure');
		expect(
			await managed.invoke('pi-session', 'route', clientRun(), 'second', request, {
				onResponse: () => undefined,
			}),
		).toHaveProperty('invocationId', 'second');
		expect(attempts).toBe(2);
		await managed.shutdown();
	});

	test('multiplexes invocations and accepts reverse completion on one routed run', async () => {
		const invokes: string[] = [];
		const target = await loopback((message, stream) => {
			if (message.message.case === 'runRequest') {
				send(
					stream,
					serverMessage({
						message: {
							case: 'runReady',
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, {
									modelId: 'composer-2.5',
								}),
							}),
						},
					}),
				);
			}
			if (message.message.case === 'invokeModel') {
				invokes.push(message.message.value.invocationId);
				if (invokes.length === 2) {
					for (const id of invokes.toReversed()) {
						send(stream, textResponse(id, id));
						send(stream, invocationEnd(id));
					}
				}
			}
			if (message.message.case === 'finishRun') {
				stream.end(encodeConnectFrame(new TextEncoder().encode('{}'), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const request = create(InferenceStreamRequestSchema);
		const seen: string[] = [];
		const first = managed.invoke('pi-session', 'route', clientRun(), 'first', request, {
			onResponse: (message) => {
				if (message.message.case === 'invocationResponse') {
					seen.push(message.message.value.invocationId);
				}
			},
		});
		const second = managed.invoke('pi-session', 'route', clientRun(), 'second', request, {
			onResponse: (message) => {
				if (message.message.case === 'invocationResponse') {
					seen.push(message.message.value.invocationId);
				}
			},
		});
		expect((await second).invocationId).toBe('second');
		expect((await first).invocationId).toBe('first');
		expect(seen).toEqual(['second', 'first']);
		expect(target.headers()?.[':path']).toBe('/aiserver.v1.InferenceService/RunInference');
		await managed.shutdown();
	});

	test('cancels one invocation without cancelling its sibling', async () => {
		let stream: ServerHttp2Stream | undefined;
		const messages: string[] = [];
		let resolveCancelObserved: () => void = () => undefined;
		const cancelObserved = new Promise<void>((resolve) => {
			resolveCancelObserved = resolve;
		});
		const target = await loopback((message, current) => {
			stream = current;
			messages.push(message.message.case ?? '<unset>');
			if (message.message.case === 'runRequest') {
				send(
					current,
					serverMessage({
						message: {
							case: 'runReady',
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, {
									modelId: 'composer-2.5',
								}),
							}),
						},
					}),
				);
			}
			if (message.message.case === 'cancelInvocation') {
				resolveCancelObserved();
				send(current, invocationEnd(message.message.value.invocationId));
			}
			if (message.message.case === 'finishRun') {
				current.end(encodeConnectFrame(new TextEncoder().encode('{}'), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const request = create(InferenceStreamRequestSchema);
		const controller = new AbortController();
		const cancelled = managed.invoke('pi-session', 'route', clientRun(), 'cancelled', request, {
			signal: controller.signal,
			onResponse: () => undefined,
		});
		const sibling = managed.invoke('pi-session', 'route', clientRun(), 'sibling', request, {
			onResponse: () => undefined,
		});
		controller.abort();
		const cancelledError = await rejection(cancelled);
		expect(cancelledError).toHaveProperty('name', 'AbortError');
		if (stream === undefined) throw new Error('loopback stream missing');
		send(stream, textResponse('sibling', 'ok'));
		send(stream, invocationEnd('sibling'));
		expect((await sibling).invocationId).toBe('sibling');
		await cancelObserved;
		expect(messages).toContain('cancelInvocation');
		expect(messages).toContain('runRequest');
		await managed.shutdown();
	});

	test('finishes the old outer run before opening a different routing key', async () => {
		let opened = 0;
		const order: string[] = [];
		const target = await loopback((message, stream) => {
			if (message.message.case === 'runRequest') {
				opened += 1;
				order.push(`run-${String(opened)}`);
				send(
					stream,
					serverMessage({
						message: {
							case: 'runReady',
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, {
									modelId: `model-${String(opened)}`,
								}),
							}),
						},
					}),
				);
			}
			if (message.message.case === 'invokeModel') {
				send(stream, invocationEnd(message.message.value.invocationId));
			}
			if (message.message.case === 'finishRun') {
				order.push(`finish-${String(opened)}`);
				stream.end(encodeConnectFrame(new TextEncoder().encode('{}'), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const request = create(InferenceStreamRequestSchema);
		await managed.invoke('pi-session', 'route-a', clientRun(), 'first', request, {
			onResponse: () => undefined,
		});
		await managed.invoke('pi-session', 'route-b', clientRun(), 'second', request, {
			onResponse: () => undefined,
		});
		expect(order.slice(0, 3)).toEqual(['run-1', 'finish-1', 'run-2']);
		await managed.shutdown();
	});

	test('fails every pending invocation on an unknown correlation id', async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case !== 'runRequest') return;
			send(
				stream,
				serverMessage({
					message: {
						case: 'runReady',
						value: create(RunInferenceRunReadySchema, {
							resolvedModel: create(InferenceRequestedModelSchema, {
								modelId: 'composer-2.5',
							}),
						}),
					},
				}),
			);
			send(stream, textResponse('unknown', 'bad'));
		});
		const managed = runtime(target);
		const failure = await rejection(
			managed.invoke(
				'pi-session',
				'route',
				clientRun(),
				'expected',
				create(InferenceStreamRequestSchema),
				{ onResponse: () => undefined },
			),
		);
		expect(failure).toHaveProperty('message', "Cursor response has unknown invocation 'unknown'");
		await managed.shutdown();
	});
});
