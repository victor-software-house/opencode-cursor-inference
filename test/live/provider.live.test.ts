import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	LanguageModelV3,
	LanguageModelV3FunctionTool,
	LanguageModelV3GenerateResult,
	LanguageModelV3Message,
} from '@ai-sdk/provider';
import { createCursor, shutdownCursorProviders } from '@cursor';

const liveRequested = process.env['OPENCODE_CURSOR_LIVE'] === '1';
const token = process.env['OPENCODE_CURSOR_LIVE_TOKEN'];
if (liveRequested && process.env['CI'] !== undefined) {
	throw new Error('Cursor live tests are local-only and refuse to run in CI');
}
if (liveRequested && (token === undefined || token === '')) {
	throw new Error('OPENCODE_CURSOR_LIVE_TOKEN is required for Cursor live tests');
}

const enabled = liveRequested && token !== undefined && token !== '';
const tool: LanguageModelV3FunctionTool = {
	type: 'function',
	name: 'join_fragments',
	description: 'Join two text fragments and return the exact concatenated text.',
	inputSchema: {
		type: 'object',
		properties: { left: { type: 'string' }, right: { type: 'string' } },
		required: ['left', 'right'],
		additionalProperties: false,
	},
} as const;

function responseText(result: LanguageModelV3GenerateResult): string {
	return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function assistantMessage(result: LanguageModelV3GenerateResult): LanguageModelV3Message {
	const content = result.content.map((part) => {
		switch (part.type) {
			case 'text':
				return {
					type: 'text' as const,
					text: part.text,
					...(part.providerMetadata === undefined
						? {}
						: { providerOptions: part.providerMetadata }),
				};
			case 'reasoning':
				return {
					type: 'reasoning' as const,
					text: part.text,
					...(part.providerMetadata === undefined
						? {}
						: { providerOptions: part.providerMetadata }),
				};
			case 'tool-call': {
				const input: unknown = JSON.parse(part.input);
				return {
					type: 'tool-call' as const,
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input,
					...(part.providerMetadata === undefined
						? {}
						: { providerOptions: part.providerMetadata }),
				};
			}
			default:
				throw new Error(`Cursor live response returned unsupported content '${part.type}'`);
		}
	});
	return { role: 'assistant', content };
}

function user(text: string): LanguageModelV3Message {
	return { role: 'user', content: [{ type: 'text', text }] };
}

function createModel(cacheDir: string): LanguageModelV3 {
	if (token === undefined || token === '') throw new Error('Cursor live credential is unavailable');
	return createCursor({
		apiKey: token,
		cacheDir,
		cursorWireModelId: 'composer-2.5',
		cursorMaxMode: false,
	}).languageModel('composer-2.5');
}

async function invoke(
	model: LanguageModelV3,
	sessionId: string,
	prompt: LanguageModelV3Message[],
): Promise<LanguageModelV3GenerateResult> {
	return await model.doGenerate({
		prompt,
		tools: [tool],
		headers: { 'x-session-affinity': sessionId },
		maxOutputTokens: 512,
	});
}

describe.skipIf(!enabled)('Cursor provider local live continuation', () => {
	test('keeps text, host tools, tool results, and resumed history across five requests', async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), 'opencode-cursor-live-'));
		const sessionId = `opencode-cursor-live-${crypto.randomUUID()}`;
		const marker = `LIVE_MARKER_${crypto.randomUUID()}`;
		const history: LanguageModelV3Message[] = [];
		try {
			let model = createModel(cacheDir);
			history.push(user(`Remember ${marker}. Reply exactly LIVE_TURN_1.`));
			const first = await invoke(model, sessionId, history);
			expect(responseText(first)).toContain('LIVE_TURN_1');
			expect(
				first.content.some(
					(part) =>
						part.type === 'reasoning' &&
						typeof part.providerMetadata?.['cursor']?.['signature'] === 'string',
				),
			).toBe(true);

			history.push(assistantMessage(first), user(`Reply with only ${marker}.`));
			const second = await invoke(model, sessionId, history);
			expect(responseText(second)).toContain(marker);

			history.push(
				assistantMessage(second),
				user(
					'Call join_fragments with left exactly "LIVE_TOOL_" and right exactly "OK". After the result, reply exactly with that result.',
				),
			);
			const callResponse = await invoke(model, sessionId, history);
			expect(callResponse.finishReason.unified).toBe('tool-calls');
			const calls = callResponse.content.filter((part) => part.type === 'tool-call');
			expect(calls).toHaveLength(1);
			const call = calls[0];
			if (call === undefined) throw new Error('Cursor live tool call is missing');
			expect(call.toolName).toBe(tool.name);
			expect(JSON.parse(call.input)).toEqual({ left: 'LIVE_TOOL_', right: 'OK' });

			history.push(assistantMessage(callResponse), {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						output: { type: 'text', value: 'LIVE_TOOL_OK' },
					},
				],
			});
			const continuation = await invoke(model, sessionId, history);
			expect(responseText(continuation)).toContain('LIVE_TOOL_OK');

			history.push(assistantMessage(continuation));
			await shutdownCursorProviders();
			model = createModel(cacheDir);
			history.push(user(`After the provider restart, reply with only ${marker}.`));
			const resumed = await invoke(model, sessionId, history);
			expect(responseText(resumed)).toContain(marker);
		} finally {
			await shutdownCursorProviders();
			await rm(cacheDir, { recursive: true, force: true });
		}
	}, 240_000);
});
