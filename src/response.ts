import { isDeepStrictEqual } from 'node:util';
import type {
	LanguageModelV3Content,
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from '@ai-sdk/provider';
import type {
	InferenceReasoningPart,
	InferenceResponseInfo,
	InferenceStreamResponse,
	InferenceToolCall,
	RunInferenceServerMessage,
} from '@cursor/gen/aiserver/v1/inference_pb';
import {
	InferenceMessageRole,
	InferenceStreamErrorType,
} from '@cursor/gen/aiserver/v1/inference_pb';

const emptyUsage = (): LanguageModelV3Usage => ({
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

interface StreamedTool {
	readonly id: string;
	readonly name: string;
	input: string;
	complete: boolean;
}

interface OpenText {
	readonly id: string;
	text: string;
}

interface OpenReasoning {
	readonly id: string;
	text: string;
	signature?: string;
}

function finishReason(tools: number, length: boolean): LanguageModelV3FinishReason {
	return {
		unified: length ? 'length' : tools > 0 ? 'tool-calls' : 'stop',
		raw: length ? 'output_token_limit' : tools > 0 ? 'tool_calls' : 'stop',
	};
}

function cursorReasoningMetadata(
	part: InferenceReasoningPart,
): Record<string, Record<string, string | boolean>> | undefined {
	const signature = part.isRedacted ? part.redactedData : part.signature;
	if (signature === undefined || signature === '') return undefined;
	return { cursor: { signature, redacted: part.isRedacted } };
}

function toolInput(tool: InferenceToolCall): string {
	if (tool.rawToolCallArgs !== undefined && tool.rawToolCallArgs !== '')
		return tool.rawToolCallArgs;
	return JSON.stringify(tool.args ?? {});
}

function validateToolInput(input: string, label: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch (error) {
		throw new Error(`Cursor ${label} returned invalid JSON tool arguments`, { cause: error });
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Cursor ${label} returned non-object tool arguments`);
	}
}

function finalContent(
	info: InferenceResponseInfo,
	allowedTools: ReadonlySet<string>,
): LanguageModelV3Content[] {
	const content: LanguageModelV3Content[] = [];
	for (const message of info.messages) {
		if (message.role === InferenceMessageRole.TOOL) continue;
		for (const reasoning of message.reasoningParts) {
			const providerMetadata = cursorReasoningMetadata(reasoning);
			content.push({
				type: 'reasoning',
				text: reasoning.text,
				...(providerMetadata === undefined ? {} : { providerMetadata }),
			});
		}
		if (message.content !== undefined && message.content !== '') {
			content.push({ type: 'text', text: message.content });
		}
		for (const tool of message.toolCalls) {
			if (!allowedTools.has(tool.toolName)) {
				throw new Error(`Cursor final response requested unknown tool '${tool.toolName}'`);
			}
			const input = toolInput(tool);
			validateToolInput(input, `final tool '${tool.toolCallId}'`);
			content.push({
				type: 'tool-call',
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				input,
			});
		}
	}
	return content;
}

function reconcileContent(
	streamed: readonly LanguageModelV3Content[],
	final: readonly LanguageModelV3Content[],
): LanguageModelV3Content[] {
	if (final.length === 0) return [...streamed];
	const streamedReasoning = streamed.filter((part) => part.type === 'reasoning');
	const finalReasoning = final.filter((part) => part.type === 'reasoning');
	let reasoning: LanguageModelV3Content[];
	if (finalReasoning.some(({ text }) => text.trim() !== '')) {
		reasoning = finalReasoning;
	} else {
		const streamedOnly = streamedReasoning.length === 1 ? streamedReasoning[0] : undefined;
		const finalOnly = finalReasoning.length === 1 ? finalReasoning[0] : undefined;
		if (
			streamedOnly !== undefined &&
			finalOnly !== undefined &&
			streamedOnly.providerMetadata === undefined &&
			finalOnly.providerMetadata !== undefined
		) {
			reasoning = [{ ...streamedOnly, providerMetadata: finalOnly.providerMetadata }];
		} else {
			reasoning = [
				...streamedReasoning,
				...finalReasoning.filter(
					(candidate) =>
						candidate.providerMetadata !== undefined &&
						!streamedReasoning.some(
							(part) =>
								part.providerMetadata?.['cursor']?.['signature'] ===
								candidate.providerMetadata?.['cursor']?.['signature'],
						),
				),
			];
		}
	}
	const finalText = final.filter((part) => part.type === 'text');
	const finalTools = final.filter((part) => part.type === 'tool-call');
	const streamedText = streamed.filter((part) => part.type === 'text');
	const streamedTools = streamed.filter((part) => part.type === 'tool-call');
	if (finalTools.length > 0 && finalText.length === 0 && streamedText.length > 0) {
		return [...reasoning, ...streamedText, ...finalTools];
	}
	const nonReasoning =
		finalText.length > 0 || finalTools.length > 0
			? final.filter((part) => part.type !== 'reasoning')
			: [...streamedText, ...streamedTools];
	return [...reasoning, ...nonReasoning];
}

export interface CursorResponseResult {
	readonly content: LanguageModelV3Content[];
	readonly usage: LanguageModelV3Usage;
	readonly finishReason: LanguageModelV3FinishReason;
	readonly response: { readonly id?: string; readonly modelId?: string; readonly timestamp?: Date };
}

export class CursorResponseMapper {
	readonly #allowedTools: ReadonlySet<string>;
	readonly #expectedInvocationId: string | undefined;
	readonly #tools = new Map<string, StreamedTool>();
	readonly #responseKinds = new Set<InferenceStreamResponse['response']['case']>();
	readonly #terminal = new Set<'output-limit'>();
	readonly #content: LanguageModelV3Content[] = [];
	#text: OpenText | undefined;
	#reasoning: OpenReasoning | undefined;
	#usage = emptyUsage();
	#responseInfo: InferenceResponseInfo | undefined;

	constructor(allowedTools: ReadonlySet<string>, expectedInvocationId?: string) {
		this.#allowedTools = allowedTools;
		this.#expectedInvocationId = expectedInvocationId;
	}

	handle(message: RunInferenceServerMessage): LanguageModelV3StreamPart[] {
		if (message.message.case !== 'invocationResponse') {
			throw new Error(`Cursor mapper received outer arm '${message.message.case ?? '<unset>'}'`);
		}
		const response = message.message.value.response;
		if (response === undefined) throw new Error('Cursor invocation response has no payload');
		return this.#handleResponse(response);
	}

	#handleResponse(response: InferenceStreamResponse): LanguageModelV3StreamPart[] {
		const part = response.response;
		const extendedUsageSeen = this.#responseKinds.has('extendedUsage');
		this.#responseKinds.add(part.case);
		switch (part.case) {
			case 'textPart': {
				const output = this.#closeReasoning();
				if (part.value.text !== '') {
					if (this.#text === undefined) {
						this.#text = { id: crypto.randomUUID(), text: '' };
						output.push({ type: 'text-start', id: this.#text.id });
					}
					this.#text.text += part.value.text;
					output.push({ type: 'text-delta', id: this.#text.id, delta: part.value.text });
				}
				if (part.value.isFinal) output.push(...this.#closeText());
				return output;
			}
			case 'thinkingPart': {
				const output = this.#closeText();
				if (
					part.value.text !== '' ||
					(part.value.signature !== undefined && part.value.signature !== '')
				) {
					if (this.#reasoning === undefined) {
						this.#reasoning = { id: crypto.randomUUID(), text: '' };
						output.push({ type: 'reasoning-start', id: this.#reasoning.id });
					}
					if (
						part.value.signature !== undefined &&
						part.value.signature !== '' &&
						this.#reasoning.signature !== undefined &&
						this.#reasoning.signature !== part.value.signature
					) {
						throw new Error('Cursor reasoning signature changed within one block');
					}
					if (part.value.signature !== undefined && part.value.signature !== '') {
						this.#reasoning.signature = part.value.signature;
					}
					if (part.value.text !== '') {
						this.#reasoning.text += part.value.text;
						output.push({
							type: 'reasoning-delta',
							id: this.#reasoning.id,
							delta: part.value.text,
						});
					}
				}
				if (part.value.isFinal) output.push(...this.#closeReasoning());
				return output;
			}
			case 'toolCallPart': {
				const incoming = part.value;
				const output = [...this.#closeText(), ...this.#closeReasoning()];
				if (!this.#allowedTools.has(incoming.toolName)) {
					throw new Error(`Cursor requested unknown tool '${incoming.toolName}'`);
				}
				let tool = this.#tools.get(incoming.toolCallId);
				if (tool === undefined) {
					tool = { id: incoming.toolCallId, name: incoming.toolName, input: '', complete: false };
					this.#tools.set(tool.id, tool);
					output.push({ type: 'tool-input-start', id: tool.id, toolName: tool.name });
				} else if (tool.name !== incoming.toolName) {
					throw new Error(`Cursor changed the name of streamed tool '${tool.id}'`);
				} else if (tool.complete) {
					throw new Error(`Cursor emitted data after completing tool '${tool.id}'`);
				}
				if (!incoming.isComplete) {
					if (incoming.args !== '') {
						tool.input += incoming.args;
						output.push({ type: 'tool-input-delta', id: tool.id, delta: incoming.args });
					}
					return output;
				}
				const completeInput = incoming.args === '' ? tool.input || '{}' : incoming.args;
				validateToolInput(completeInput, `streamed tool '${tool.id}'`);
				if (
					tool.input !== '' &&
					!isDeepStrictEqual(JSON.parse(tool.input), JSON.parse(completeInput))
				) {
					throw new Error(`Cursor tool '${tool.id}' argument stream does not match completion`);
				}
				if (tool.input === '' && completeInput !== '') {
					output.push({ type: 'tool-input-delta', id: tool.id, delta: completeInput });
				}
				tool.input = completeInput;
				tool.complete = true;
				output.push(
					{ type: 'tool-input-end', id: tool.id },
					{
						type: 'tool-call',
						toolCallId: tool.id,
						toolName: tool.name,
						input: tool.input,
					},
				);
				return output;
			}
			case 'usage':
				if (extendedUsageSeen) return [];
				this.#usage = {
					inputTokens: {
						total: part.value.promptTokens,
						noCache: part.value.promptTokens,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: {
						total: part.value.completionTokens,
						text: part.value.completionTokens,
						reasoning: undefined,
					},
				};
				return [];
			case 'extendedUsage': {
				const noCache = Math.max(0, part.value.inputTokens - part.value.cacheReadTokens);
				this.#usage = {
					inputTokens: {
						total: part.value.inputTokens,
						noCache,
						cacheRead: part.value.cacheReadTokens,
						cacheWrite: part.value.cacheWriteTokens,
					},
					outputTokens: {
						total: part.value.outputTokens,
						text: part.value.outputTokens,
						reasoning: undefined,
					},
				};
				return [];
			}
			case 'responseInfo':
				if (part.value.errorMessage !== undefined && part.value.errorMessage !== '') {
					throw new Error(`Cursor inference failed: ${part.value.errorMessage}`);
				}
				this.#responseInfo = part.value;
				return [];
			case 'error':
				if (
					part.value.isOutputTokenLimitError ||
					part.value.errorType === InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT
				) {
					this.#terminal.add('output-limit');
					return [];
				}
				throw new Error(
					`Cursor inference failed${part.value.code === '' ? '' : ` (${part.value.code})`}: ${part.value.message}`,
				);
			case 'invocationId':
				if (
					this.#expectedInvocationId !== undefined &&
					part.value.invocationId !== this.#expectedInvocationId
				) {
					throw new Error('Cursor nested invocation identity does not match its outer envelope');
				}
				return [];
			case 'providerMetadata':
			case 'imageDescriptions':
				return [];
			case undefined:
				throw new Error('Cursor inference response has no arm');
			default:
				throw new Error('Cursor inference response has an unsupported arm');
		}
	}

	#closeText(): LanguageModelV3StreamPart[] {
		const text = this.#text;
		if (text === undefined) return [];
		this.#text = undefined;
		this.#content.push({ type: 'text', text: text.text });
		return [{ type: 'text-end', id: text.id }];
	}

	#closeReasoning(): LanguageModelV3StreamPart[] {
		const reasoning = this.#reasoning;
		if (reasoning === undefined) return [];
		this.#reasoning = undefined;
		const providerMetadata =
			reasoning.signature === undefined
				? undefined
				: { cursor: { signature: reasoning.signature, redacted: false } };
		this.#content.push({
			type: 'reasoning',
			text: reasoning.text,
			...(providerMetadata === undefined ? {} : { providerMetadata }),
		});
		return [
			{
				type: 'reasoning-end',
				id: reasoning.id,
				...(providerMetadata === undefined ? {} : { providerMetadata }),
			},
		];
	}

	finish(): { readonly parts: LanguageModelV3StreamPart[]; readonly result: CursorResponseResult } {
		const parts = [...this.#closeText(), ...this.#closeReasoning()];
		for (const tool of this.#tools.values()) {
			if (!tool.complete) throw new Error(`Cursor ended before completing tool '${tool.id}'`);
			this.#content.push({
				type: 'tool-call',
				toolCallId: tool.id,
				toolName: tool.name,
				input: tool.input,
			});
		}
		const final =
			this.#responseInfo === undefined ? [] : finalContent(this.#responseInfo, this.#allowedTools);
		const streamedContent = [...this.#content];
		const finalTools = final.filter((part) => part.type === 'tool-call');
		if (this.#tools.size > 0 && finalTools.length > 0) {
			if (finalTools.length !== this.#tools.size) {
				throw new Error('Cursor final response tool set does not match streamed tools');
			}
			for (const candidate of finalTools) {
				const streamed = this.#tools.get(candidate.toolCallId);
				if (
					streamed === undefined ||
					streamed.name !== candidate.toolName ||
					!isDeepStrictEqual(JSON.parse(streamed.input), JSON.parse(candidate.input))
				) {
					throw new Error('Cursor final response tool set does not match streamed tools');
				}
			}
		}
		const streamedText = this.#content.some((part) => part.type === 'text');
		const streamedReasoning = this.#content.filter((part) => part.type === 'reasoning');
		const streamedToolIds = new Set(
			this.#content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : [])),
		);
		for (const candidate of final) {
			if (candidate.type === 'text' && !streamedText) {
				const id = crypto.randomUUID();
				parts.push(
					{ type: 'text-start', id },
					{ type: 'text-delta', id, delta: candidate.text },
					{ type: 'text-end', id },
				);
				this.#content.push(candidate);
				continue;
			}
			if (candidate.type === 'reasoning' && streamedReasoning.length === 0) {
				const id = crypto.randomUUID();
				parts.push(
					{ type: 'reasoning-start', id },
					...(candidate.text === ''
						? []
						: [{ type: 'reasoning-delta' as const, id, delta: candidate.text }]),
					{
						type: 'reasoning-end',
						id,
						...(candidate.providerMetadata === undefined
							? {}
							: { providerMetadata: candidate.providerMetadata }),
					},
				);
				this.#content.push(candidate);
				continue;
			}
			if (
				candidate.type === 'reasoning' &&
				candidate.providerMetadata !== undefined &&
				!streamedReasoning.some(
					(part) =>
						part.providerMetadata?.['cursor']?.['signature'] ===
						candidate.providerMetadata?.['cursor']?.['signature'],
				)
			) {
				const metadataOnly: LanguageModelV3Content = {
					type: 'reasoning',
					text: '',
					providerMetadata: candidate.providerMetadata,
				};
				const id = crypto.randomUUID();
				parts.push(
					{ type: 'reasoning-start', id },
					{ type: 'reasoning-end', id, providerMetadata: candidate.providerMetadata },
				);
				this.#content.push(metadataOnly);
				continue;
			}
			if (candidate.type === 'tool-call' && !streamedToolIds.has(candidate.toolCallId)) {
				parts.push({
					type: 'tool-call',
					toolCallId: candidate.toolCallId,
					toolName: candidate.toolName,
					input: candidate.input,
				});
				this.#content.push(candidate);
			}
		}
		const content = reconcileContent(streamedContent, final);
		const outputLimit = this.#terminal.has('output-limit');
		if (outputLimit && content.length === 0) {
			throw new Error('Cursor inference reached its output token limit without producing output');
		}
		const result: CursorResponseResult = {
			content,
			usage: this.#usage,
			finishReason: finishReason(
				content.filter((part) => part.type === 'tool-call').length,
				outputLimit,
			),
			response: {
				...(this.#responseInfo?.id === undefined || this.#responseInfo.id === ''
					? {}
					: { id: this.#responseInfo.id }),
				...(this.#responseInfo?.model === undefined || this.#responseInfo.model === ''
					? {}
					: { modelId: this.#responseInfo.model }),
				...(this.#responseInfo?.createdAt !== undefined && this.#responseInfo.createdAt > 0n
					? { timestamp: new Date(Number(this.#responseInfo.createdAt)) }
					: {}),
			},
		};
		return { parts, result };
	}
}
