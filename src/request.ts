import type {
	LanguageModelV3CallOptions,
	LanguageModelV3FilePart,
	LanguageModelV3Message,
	LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';
import type { JsonObject, JsonValue } from '@bufbuild/protobuf';
import { create, fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type {
	InferenceContentPart,
	InferenceCoreMessage,
	InferenceModelConfig,
	InferenceRequestedModel,
	InferenceStreamRequest,
	RunInferenceRoutingMessage,
	RunInferenceRunRequest,
} from '@cursor/gen/aiserver/v1/inference_pb';
import {
	InferenceAgentToolSchema,
	InferenceContentPartSchema,
	InferenceContentPartsSchema,
	InferenceCoreMessageSchema,
	InferenceImagePartSchema,
	InferenceMessageRole,
	InferenceModelConfigSchema,
	InferenceModelParameterValueSchema,
	InferenceReasoningPartSchema,
	InferenceRequestedModelSchema,
	InferenceStreamRequestSchema,
	InferenceTextPartSchema,
	InferenceToolCallSchema,
	InferenceToolResultContentSchema,
	InferenceToolResultPartSchema,
	RunInferenceRoutingMessageSchema,
	RunInferenceRoutingRole,
	RunInferenceRunRequestSchema,
} from '@cursor/gen/aiserver/v1/inference_pb';
import { validateCursorImage } from '@cursor/image';
import { isRecord, omitUndefined } from '@victor-software-house/pi-type-kit';

export interface CursorModelParameter {
	readonly id: string;
	readonly value: string;
}

export interface CursorModelSelection {
	readonly wireModelId: string;
	readonly maxMode: boolean;
	readonly parameters: readonly CursorModelParameter[];
}

function requiredObject(value: unknown, label: string): JsonObject {
	const converted = protobufJson(value);
	if (!isRecord(converted)) throw new Error(`${label} must be a JSON object`);
	return converted;
}

function protobufJson(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('Cursor tool result contains a non-finite number');
		return value;
	}
	if (Array.isArray(value)) return value.map(protobufJson);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, protobufJson(item)]),
		);
	}
	throw new Error('Cursor tool result is not JSON-serializable');
}

function textPart(text: string): InferenceContentPart {
	return create(InferenceContentPartSchema, {
		part: { case: 'text', value: create(InferenceTextPartSchema, { text }) },
	});
}

function fileData(part: LanguageModelV3FilePart): string {
	if (part.data instanceof URL) throw new Error('Cursor does not support URL image inputs');
	return typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64');
}

function imagePart(part: LanguageModelV3FilePart): InferenceContentPart {
	const image = validateCursorImage({ data: fileData(part), mimeType: part.mediaType });
	return create(InferenceContentPartSchema, {
		part: {
			case: 'image',
			value: create(InferenceImagePartSchema, { data: image.data, mimeType: image.mimeType }),
		},
	});
}

function cursorReasoningMetadata(part: { readonly providerOptions?: Record<string, unknown> }): {
	readonly signature?: string;
	readonly redacted?: boolean;
} {
	const metadata = part.providerOptions?.['cursor'];
	if (!isRecord(metadata)) return {};
	return omitUndefined({
		signature: typeof metadata['signature'] === 'string' ? metadata['signature'] : undefined,
		redacted: metadata['redacted'] === true ? true : undefined,
	});
}

function toolOutput(output: LanguageModelV3ToolResultOutput): {
	readonly value: JsonValue;
	readonly error: boolean;
	readonly experimental: InferenceContentPart[];
} {
	switch (output.type) {
		case 'text':
			return { value: output.value, error: false, experimental: [] };
		case 'json':
			return { value: protobufJson(output.value), error: false, experimental: [] };
		case 'error-text':
			return { value: output.value, error: true, experimental: [] };
		case 'error-json':
			return { value: protobufJson(output.value), error: true, experimental: [] };
		case 'execution-denied':
			return { value: output.reason ?? 'Tool execution denied', error: true, experimental: [] };
		case 'content': {
			const text: string[] = [];
			const experimental: InferenceContentPart[] = [];
			let hasImage = false;
			for (const part of output.value) {
				if (part.type === 'text') {
					text.push(part.text);
					experimental.push(textPart(part.text));
					continue;
				}
				if (part.type === 'image-data' || part.type === 'file-data') {
					if (!part.mediaType.startsWith('image/')) {
						throw new Error(`Cursor tool results do not support '${part.mediaType}' files`);
					}
					hasImage = true;
					experimental.push(
						imagePart({ type: 'file', data: part.data, mediaType: part.mediaType }),
					);
					continue;
				}
				throw new Error(`Cursor tool result content '${part.type}' is unsupported`);
			}
			return {
				value:
					text.length === 1
						? (text[0] ?? '')
						: text.map((value) => ({ type: 'text', text: value })),
				error: false,
				experimental: hasImage ? experimental : [],
			};
		}
		default:
			throw new Error('Cursor tool result has an unsupported output arm');
	}
}

export function messageToInference(message: LanguageModelV3Message): InferenceCoreMessage {
	if (message.role === 'system') {
		return create(InferenceCoreMessageSchema, {
			role: InferenceMessageRole.SYSTEM,
			content: { case: 'text', value: message.content },
		});
	}
	if (message.role === 'user') {
		const parts = message.content.map((part) =>
			part.type === 'text' ? textPart(part.text) : imagePart(part),
		);
		if (parts.every((_, index) => message.content[index]?.type === 'text')) {
			return create(InferenceCoreMessageSchema, {
				role: InferenceMessageRole.USER,
				content: {
					case: 'text',
					value: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
				},
			});
		}
		return create(InferenceCoreMessageSchema, {
			role: InferenceMessageRole.USER,
			content: {
				case: 'parts',
				value: create(InferenceContentPartsSchema, { parts }),
			},
		});
	}
	if (message.role === 'assistant') {
		const text: string[] = [];
		const reasoningParts = [];
		const toolCalls = [];
		for (const part of message.content) {
			if (part.type === 'text') text.push(part.text);
			else if (part.type === 'reasoning') {
				const metadata = cursorReasoningMetadata(part);
				reasoningParts.push(
					create(
						InferenceReasoningPartSchema,
						omitUndefined({
							isRedacted: metadata.redacted === true,
							text: part.text,
							signature: metadata.redacted === true ? undefined : metadata.signature,
							redactedData: metadata.redacted === true ? metadata.signature : undefined,
						}),
					),
				);
			} else if (part.type === 'tool-call') {
				const input = requiredObject(part.input, `Cursor tool '${part.toolName}' input`);
				toolCalls.push(
					create(InferenceToolCallSchema, {
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						args: input,
						rawToolCallArgs: JSON.stringify(input),
					}),
				);
			} else if (part.type === 'file') {
				throw new Error('Cursor assistant file history is unsupported');
			} else {
				throw new Error('Cursor assistant tool-result history must use a tool message');
			}
		}
		return create(
			InferenceCoreMessageSchema,
			omitUndefined({
				role: InferenceMessageRole.ASSISTANT,
				content: text.length === 0 ? undefined : { case: 'text' as const, value: text.join('') },
				reasoningParts,
				toolCalls,
			}),
		);
	}
	const parts = message.content.map((part) => {
		if (part.type === 'tool-approval-response') {
			throw new Error('Cursor does not support provider-executed tool approval responses');
		}
		const output = toolOutput(part.output);
		return create(InferenceToolResultPartSchema, {
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			result: fromJson(ValueSchema, output.value),
			isError: output.error,
			experimentalContent: output.experimental,
		});
	});
	return create(InferenceCoreMessageSchema, {
		role: InferenceMessageRole.TOOL,
		content: {
			case: 'toolContent',
			value: create(InferenceToolResultContentSchema, { parts }),
		},
	});
}

function modelConfig(options: LanguageModelV3CallOptions): InferenceModelConfig | undefined {
	if (
		options.maxOutputTokens === undefined &&
		options.temperature === undefined &&
		options.topP === undefined &&
		options.stopSequences === undefined
	) {
		return undefined;
	}
	return create(
		InferenceModelConfigSchema,
		omitUndefined({
			maxTokens: options.maxOutputTokens,
			temperature: options.temperature,
			topP: options.topP,
			stopSequences: options.stopSequences,
		}),
	);
}

function validateOptions(options: LanguageModelV3CallOptions): void {
	if (options.topK !== undefined) throw new Error('Cursor RunInference does not support topK');
	if (options.presencePenalty !== undefined)
		throw new Error('Cursor RunInference does not support presencePenalty');
	if (options.frequencyPenalty !== undefined)
		throw new Error('Cursor RunInference does not support frequencyPenalty');
	if (options.seed !== undefined) throw new Error('Cursor RunInference does not support seed');
	if (options.responseFormat?.type === 'json') {
		throw new Error('Cursor RunInference does not support structured response formats');
	}
	if (options.toolChoice?.type === 'required' || options.toolChoice?.type === 'tool') {
		throw new Error(`Cursor RunInference does not support toolChoice '${options.toolChoice.type}'`);
	}
}

export function buildInferenceRequest(options: LanguageModelV3CallOptions): InferenceStreamRequest {
	validateOptions(options);
	const tools = (options.toolChoice?.type === 'none' ? [] : (options.tools ?? [])).map((tool) => {
		if (tool.type !== 'function')
			throw new Error(`Cursor provider tool '${tool.name}' is unsupported`);
		const jsonSchema = requiredObject(tool.inputSchema, `Cursor tool '${tool.name}' schema`);
		return create(InferenceAgentToolSchema, {
			name: tool.name,
			description: tool.description ?? '',
			parameters: { jsonSchema },
		});
	});
	return create(
		InferenceStreamRequestSchema,
		omitUndefined({
			messages: options.prompt.map(messageToInference),
			tools,
			modelConfig: modelConfig(options),
		}),
	);
}

function messageText(message: LanguageModelV3Message): string {
	if (message.role === 'system' || message.role === 'tool') return '';
	return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function routingConversation(prompt: LanguageModelV3Message[]): RunInferenceRoutingMessage[] {
	return prompt.flatMap((message) => {
		if (message.role === 'system' || message.role === 'tool') return [];
		const text = messageText(message);
		if (text === '') return [];
		return [
			create(RunInferenceRoutingMessageSchema, {
				role:
					message.role === 'user'
						? RunInferenceRoutingRole.USER
						: RunInferenceRoutingRole.ASSISTANT,
				text,
			}),
		];
	});
}

export function inferenceRequestedModel(selection: CursorModelSelection): InferenceRequestedModel {
	return create(InferenceRequestedModelSchema, {
		modelId: selection.wireModelId,
		maxMode: selection.maxMode,
		parameters: selection.parameters.map((parameter) =>
			create(InferenceModelParameterValueSchema, parameter),
		),
	});
}

export function inferenceRoutingKey(selection: CursorModelSelection): string {
	return JSON.stringify(inferenceRequestedModel(selection));
}

export function buildInferenceRunRequest(
	selection: CursorModelSelection,
	prompt: LanguageModelV3Message[],
	sessionId: string,
): RunInferenceRunRequest {
	if (sessionId === '')
		throw new Error('Cursor managed inference requires a stable OpenCode session id');
	return create(RunInferenceRunRequestSchema, {
		conversationId: sessionId,
		requestedModel: inferenceRequestedModel(selection),
		routingConversation: routingConversation(prompt),
		agentMode: 'agent',
	});
}
