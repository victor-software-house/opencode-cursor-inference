import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { buildInferenceRequest, buildInferenceRunRequest } from '@cursor/request';

function options(overrides: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
	return {
		prompt: [
			{ role: 'system', content: 'Be precise.' },
			{ role: 'user', content: [{ type: 'text', text: 'Read the file.' }] },
			{
				role: 'assistant',
				content: [
					{
						type: 'reasoning',
						text: 'Need a tool.',
						providerOptions: { cursor: { signature: 'sig' } },
					},
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'read',
						input: { path: 'README.md' },
					},
				],
			},
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call-1',
						toolName: 'read',
						output: { type: 'text', value: 'contents' },
					},
				],
			},
		],
		tools: [
			{
				type: 'function',
				name: 'read',
				description: 'Read one file',
				inputSchema: {
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				},
			},
		],
		...overrides,
	};
}

describe('Cursor inference request mapping', () => {
	test('maps complete AI SDK history and arbitrary tool schemas', () => {
		const request = buildInferenceRequest(options());
		expect(request.messages).toHaveLength(4);
		expect(request.messages[2]?.reasoningParts[0]).toMatchObject({
			text: 'Need a tool.',
			signature: 'sig',
		});
		expect(request.messages[2]?.toolCalls[0]).toMatchObject({
			toolCallId: 'call-1',
			toolName: 'read',
			args: { path: 'README.md' },
		});
		expect(request.messages[3]?.content.case).toBe('toolContent');
		expect(request.tools[0]).toMatchObject({
			name: 'read',
			parameters: { type: 'object', required: ['path'] },
		});
	});

	test('fails closed on unsupported request controls', () => {
		expect(() => buildInferenceRequest(options({ topK: 10 }))).toThrow('does not support topK');
		expect(() =>
			buildInferenceRequest(
				options({ responseFormat: { type: 'json', schema: { type: 'object' } } }),
			),
		).toThrow('does not support structured response formats');
	});

	test('builds the routed outer run from host-owned history', () => {
		const request = buildInferenceRunRequest(
			{ wireModelId: 'claude-test', maxMode: true, context: '1m' },
			options().prompt,
			'session-1',
		);
		expect(request).toMatchObject({
			conversationId: 'session-1',
			agentMode: 'agent',
			requestedModel: {
				modelId: 'claude-test',
				maxMode: true,
				parameters: [{ id: 'context', value: '1m' }],
			},
		});
		expect(request.routingConversation.map(({ text }) => text)).toEqual(['Read the file.']);
	});
});
