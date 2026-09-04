import { describe, expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import {
	InferenceMessageRole,
	InferenceReasoningPartSchema,
	InferenceResponseInfoSchema,
	InferenceResponseMessageSchema,
	InferenceStreamErrorSchema,
	InferenceStreamErrorType,
	InferenceStreamResponseSchema,
	InferenceTextStreamPartSchema,
	InferenceThinkingStreamPartSchema,
	InferenceToolCallSchema,
	InferenceToolCallStreamPartSchema,
	InferenceUsageInfoSchema,
	RunInferenceInvocationResponseSchema,
	RunInferenceServerMessageSchema,
} from '@cursor/gen/aiserver/v1/inference_pb';
import { CursorResponseMapper } from '@cursor/response';

function envelope(response: ReturnType<typeof create<typeof InferenceStreamResponseSchema>>) {
	return create(RunInferenceServerMessageSchema, {
		message: {
			case: 'invocationResponse',
			value: create(RunInferenceInvocationResponseSchema, {
				invocationId: 'invocation-1',
				response,
			}),
		},
	});
}

function text(value: string, isFinal = false) {
	return envelope(
		create(InferenceStreamResponseSchema, {
			response: {
				case: 'textPart',
				value: create(InferenceTextStreamPartSchema, { text: value, isFinal }),
			},
		}),
	);
}

function reasoning(value: string, signature: string | undefined, isFinal = false) {
	return envelope(
		create(InferenceStreamResponseSchema, {
			response: {
				case: 'thinkingPart',
				value: create(InferenceThinkingStreamPartSchema, {
					text: value,
					...(signature === undefined ? {} : { signature }),
					isFinal,
				}),
			},
		}),
	);
}

describe('Cursor AI SDK response mapping', () => {
	test('preserves interleaved reasoning, text, tool calls, usage, and final metadata', () => {
		const mapper = new CursorResponseMapper();
		const events = [
			...mapper.handle(reasoning('Need ', undefined)),
			...mapper.handle(reasoning('file.', 'signed-reasoning', true)),
			...mapper.handle(text('Reading ', false)),
			...mapper.handle(text('now.', true)),
			...mapper.handle(
				envelope(
					create(InferenceStreamResponseSchema, {
						response: {
							case: 'toolCallPart',
							value: create(InferenceToolCallStreamPartSchema, {
								toolCallId: 'call-1',
								toolName: 'read',
								args: '{"path":"README.md"}',
								isComplete: true,
							}),
						},
					}),
				),
			),
			...mapper.handle(
				envelope(
					create(InferenceStreamResponseSchema, {
						response: {
							case: 'usage',
							value: create(InferenceUsageInfoSchema, { promptTokens: 20, completionTokens: 5 }),
						},
					}),
				),
			),
		];
		const final = mapper.finish();
		expect(events.map(({ type }) => type)).toEqual([
			'reasoning-start',
			'reasoning-delta',
			'reasoning-delta',
			'reasoning-end',
			'text-start',
			'text-delta',
			'text-delta',
			'text-end',
			'tool-input-start',
			'tool-input-delta',
			'tool-input-end',
			'tool-call',
		]);
		expect(events[3]).toMatchObject({
			type: 'reasoning-end',
			providerMetadata: { cursor: { signature: 'signed-reasoning', redacted: false } },
		});
		expect(final.result.content).toMatchObject([
			{ type: 'reasoning', text: 'Need file.' },
			{ type: 'text', text: 'Reading now.' },
			{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read' },
		]);
		expect(final.result.finishReason.unified).toBe('tool-calls');
		expect(final.result.usage).toMatchObject({
			inputTokens: { total: 20, noCache: 20 },
			outputTokens: { total: 5, text: 5 },
		});
	});

	test('uses final-only response data and keeps opaque reasoning signatures', () => {
		const mapper = new CursorResponseMapper();
		mapper.handle(
			envelope(
				create(InferenceStreamResponseSchema, {
					response: {
						case: 'responseInfo',
						value: create(InferenceResponseInfoSchema, {
							id: 'response-1',
							model: 'cursor-model',
							createdAt: 1_700_000_000n,
							messages: [
								create(InferenceResponseMessageSchema, {
									role: InferenceMessageRole.ASSISTANT,
									content: 'Done',
									reasoningParts: [
										create(InferenceReasoningPartSchema, {
											isRedacted: true,
											redactedData: 'opaque-signature',
										}),
									],
									toolCalls: [
										create(InferenceToolCallSchema, {
											toolCallId: 'call-final',
											toolName: 'read',
											rawToolCallArgs: '{"path":"README.md"}',
										}),
									],
								}),
							],
						}),
					},
				}),
			),
		);
		const result = mapper.finish();
		expect(result.result.response).toMatchObject({ id: 'response-1', modelId: 'cursor-model' });
		expect(result.result.content).toContainEqual({
			type: 'reasoning',
			text: '',
			providerMetadata: { cursor: { signature: 'opaque-signature', redacted: true } },
		});
		expect(result.result.content).toContainEqual({ type: 'text', text: 'Done' });
		expect(result.result.content).toContainEqual({
			type: 'tool-call',
			toolCallId: 'call-final',
			toolName: 'read',
			input: '{"path":"README.md"}',
		});
	});

	test('uses the complete tool frame as authoritative and accepts unnamed argument deltas', () => {
		const frame = (args: string, isComplete: boolean, toolName = '') =>
			envelope(
				create(InferenceStreamResponseSchema, {
					response: {
						case: 'toolCallPart',
						value: create(InferenceToolCallStreamPartSchema, {
							toolCallId: 'call-1',
							toolName,
							args,
							isComplete,
						}),
					},
				}),
			);
		const mapper = new CursorResponseMapper();
		mapper.handle(frame('', false, 'read'));
		mapper.handle(frame('{"path":', false));
		mapper.handle(frame('"README.md"}', false));
		mapper.handle(frame('{"path":"README.md"}', true, 'read'));
		expect(mapper.finish().result.content).toContainEqual({
			type: 'tool-call',
			toolCallId: 'call-1',
			toolName: 'read',
			input: '{"path":"README.md"}',
		});

		const mismatch = new CursorResponseMapper();
		mismatch.handle(frame('', false, 'read'));
		mismatch.handle(frame('{"path":"other"}', false));
		expect(() => mismatch.handle(frame('{"path":"README.md"}', true, 'read'))).toThrow(
			'argument stream does not match completion',
		);
	});

	test('maps an output limit with partial content to length', () => {
		const mapper = new CursorResponseMapper();
		mapper.handle(text('partial', true));
		mapper.handle(
			envelope(
				create(InferenceStreamResponseSchema, {
					response: {
						case: 'error',
						value: create(InferenceStreamErrorSchema, {
							message: 'limit',
							isOutputTokenLimitError: true,
							errorType: InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT,
						}),
					},
				}),
			),
		);
		expect(mapper.finish().result.finishReason.unified).toBe('length');
	});

	test('passes an unavailable tool name to OpenCode for host-owned handling', () => {
		const mapper = new CursorResponseMapper();
		const events = mapper.handle(
			envelope(
				create(InferenceStreamResponseSchema, {
					response: {
						case: 'toolCallPart',
						value: create(InferenceToolCallStreamPartSchema, {
							toolCallId: 'call-1',
							toolName: 'unavailable_tool',
							args: '{}',
							isComplete: true,
						}),
					},
				}),
			),
		);
		expect(events).toContainEqual({
			type: 'tool-call',
			toolCallId: 'call-1',
			toolName: 'unavailable_tool',
			input: '{}',
		});
		expect(mapper.finish().result.finishReason.unified).toBe('tool-calls');
	});
});
