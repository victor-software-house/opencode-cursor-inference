import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { create } from '@bufbuild/protobuf';
import {
	RunInferenceClientMessageSchema,
	type RunInferenceServerMessage,
} from '@cursor/gen/aiserver/v1/inference_pb';
import { isRecord } from '@cursor/guards';
import { loadCursorMachineIdentity } from '@cursor/identity';
import { registerCursorShutdown } from '@cursor/lifecycle';
import {
	buildInferenceRequest,
	buildInferenceRunRequest,
	type CursorModelSelection,
	inferenceRoutingKey,
} from '@cursor/request';
import { CursorResponseMapper, type CursorResponseResult } from '@cursor/response';
import { CursorInferenceRuntime } from '@cursor/transport';

const backendUrl = 'https://api2.cursor.sh';
const runtimes = new Set<Promise<CursorInferenceRuntime>>();

export interface CursorProviderOptions {
	readonly name?: string;
	readonly accessToken?: string;
	readonly cacheDir?: string;
}

export interface CursorProvider {
	(modelId: string): LanguageModelV3;
	languageModel(modelId: string): LanguageModelV3;
}

function requiredSessionId(options: LanguageModelV3CallOptions): string {
	for (const [key, value] of Object.entries(options.headers ?? {})) {
		if (
			(key.toLowerCase() === 'x-session-affinity' || key.toLowerCase() === 'x-session-id') &&
			typeof value === 'string' &&
			value !== ''
		) {
			return value;
		}
	}
	throw new Error('Cursor managed inference requires OpenCode to provide a session header');
}

function modelSelection(
	modelId: string,
	options: LanguageModelV3CallOptions,
): CursorModelSelection {
	const value = options.providerOptions?.['cursor'];
	if (value !== undefined && !isRecord(value)) {
		throw new Error('Cursor provider options must be an object');
	}
	const wireModelId = value?.['cursorWireModelId'] ?? modelId.replace(/-max$/u, '');
	const maxMode = value?.['cursorMaxMode'] ?? modelId.endsWith('-max');
	const context = value?.['cursorContext'];
	if (typeof wireModelId !== 'string' || wireModelId === '') {
		throw new Error('Cursor wire model id must be a non-empty string');
	}
	if (typeof maxMode !== 'boolean') throw new Error('Cursor max mode must be a boolean');
	if (context !== undefined && typeof context !== 'string') {
		throw new Error('Cursor context parameter must be a string');
	}
	return { wireModelId, maxMode, ...(context === undefined ? {} : { context }) };
}

function allowedTools(options: LanguageModelV3CallOptions): Set<string> {
	return new Set(
		(options.tools ?? []).flatMap((tool) => (tool.type === 'function' ? [tool.name] : [])),
	);
}

class CursorLanguageModel implements LanguageModelV3 {
	readonly specificationVersion = 'v3' as const;
	readonly provider: string;
	readonly modelId: string;
	readonly supportedUrls = {};
	readonly #runtime: () => Promise<CursorInferenceRuntime>;

	constructor(provider: string, modelId: string, runtime: () => Promise<CursorInferenceRuntime>) {
		this.provider = provider;
		this.modelId = modelId;
		this.#runtime = runtime;
	}

	async #execute(
		options: LanguageModelV3CallOptions,
		onPart?: (part: LanguageModelV3StreamPart) => void,
	): Promise<CursorResponseResult> {
		const sessionId = requiredSessionId(options);
		const selection = modelSelection(this.modelId, options);
		const invocationId = crypto.randomUUID();
		const mapper = new CursorResponseMapper(allowedTools(options), invocationId);
		const runRequest = create(RunInferenceClientMessageSchema, {
			message: {
				case: 'runRequest',
				value: buildInferenceRunRequest(selection, options.prompt, sessionId),
			},
		});
		await (await this.#runtime()).invoke(
			sessionId,
			inferenceRoutingKey(selection),
			runRequest,
			invocationId,
			buildInferenceRequest(options),
			{
				...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
				onResponse(message: RunInferenceServerMessage) {
					for (const part of mapper.handle(message)) onPart?.(part);
				},
			},
		);
		const finished = mapper.finish();
		for (const part of finished.parts) onPart?.(part);
		return finished.result;
	}

	async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
		const result = await this.#execute(options);
		return {
			content: result.content,
			finishReason: result.finishReason,
			usage: result.usage,
			response: result.response,
			warnings: [],
		};
	}

	async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
		const stream = new ReadableStream<LanguageModelV3StreamPart>({
			start: (controller) => {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				void this.#execute(options, (part) => controller.enqueue(part)).then(
					(result) => {
						if (Object.keys(result.response).length > 0) {
							controller.enqueue({ type: 'response-metadata', ...result.response });
						}
						controller.enqueue({
							type: 'finish',
							usage: result.usage,
							finishReason: result.finishReason,
						});
						controller.close();
						return undefined;
					},
					(error: unknown) => {
						controller.enqueue({ type: 'error', error });
						controller.close();
						return undefined;
					},
				);
			},
		});
		return { stream };
	}
}

export async function shutdownCursorProviders(): Promise<void> {
	const active = [...runtimes];
	runtimes.clear();
	await Promise.allSettled(active.map(async (runtime) => await (await runtime).shutdown()));
}

registerCursorShutdown(shutdownCursorProviders);

export function createCursor(options: CursorProviderOptions = {}): CursorProvider {
	const accessToken = options.accessToken;
	if (accessToken === undefined || accessToken === '') {
		throw new Error('Cursor access token is unavailable; run `opencode auth login` for Cursor');
	}
	const cacheDir = options.cacheDir;
	if (cacheDir === undefined || cacheDir === '') {
		throw new Error('Cursor provider cache directory is unavailable');
	}
	let runtime: Promise<CursorInferenceRuntime> | undefined;
	const getRuntime = (): Promise<CursorInferenceRuntime> => {
		if (runtime !== undefined) return runtime;
		runtime = loadCursorMachineIdentity(cacheDir).then(
			(identity) =>
				new CursorInferenceRuntime({
					backendUrl,
					token: accessToken,
					ghostMode: false,
					identity,
				}),
		);
		runtimes.add(runtime);
		return runtime;
	};
	const providerName = options.name ?? 'cursor';
	const provider = Object.assign(
		(modelId: string) => new CursorLanguageModel(providerName, modelId, getRuntime),
		{
			languageModel: (modelId: string) =>
				new CursorLanguageModel(providerName, modelId, getRuntime),
		},
	) satisfies CursorProvider;
	return provider;
}
