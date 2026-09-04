import { appendFileSync } from 'node:fs';

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function model(modelId) {
	return {
		specificationVersion: 'v3',
		provider: 'smoke',
		modelId,
		supportedUrls: {},
		async doGenerate(options) {
			const streamed = await this.doStream(options);
			const content = [];
			let finishReason = { unified: 'stop', raw: 'stop' };
			for await (const part of streamed.stream) {
				if (part.type === 'text-delta') content.push({ type: 'text', text: part.delta });
				if (part.type === 'tool-call') content.push(part);
				if (part.type === 'finish') finishReason = part.finishReason;
			}
			return { content, finishReason, usage, warnings: [] };
		},
		async doStream(options) {
			appendFileSync(process.env.OPENCODE_CURSOR_SMOKE_LOG, `${JSON.stringify(options.prompt)}\n`);
			const continued = options.prompt.some(
				(message) =>
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === 'tool-result'),
			);
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: 'stream-start', warnings: [] });
						if (continued) {
							controller.enqueue({ type: 'text-start', id: 'text-1' });
							controller.enqueue({
								type: 'text-delta',
								id: 'text-1',
								delta: 'OPENCODE_CURSOR_SMOKE_OK',
							});
							controller.enqueue({ type: 'text-end', id: 'text-1' });
							controller.enqueue({
								type: 'finish',
								finishReason: { unified: 'stop', raw: 'stop' },
								usage,
							});
						} else {
							const input = JSON.stringify({ filePath: process.env.OPENCODE_CURSOR_SMOKE_FILE });
							controller.enqueue({ type: 'tool-input-start', id: 'call-1', toolName: 'read' });
							controller.enqueue({ type: 'tool-input-delta', id: 'call-1', delta: input });
							controller.enqueue({ type: 'tool-input-end', id: 'call-1' });
							controller.enqueue({
								type: 'tool-call',
								toolCallId: 'call-1',
								toolName: 'read',
								input,
							});
							controller.enqueue({
								type: 'finish',
								finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
								usage,
							});
						}
						controller.close();
					},
				}),
			};
		},
	};
}

export function createSmoke() {
	const provider = (modelId) => model(modelId);
	provider.languageModel = model;
	return provider;
}
