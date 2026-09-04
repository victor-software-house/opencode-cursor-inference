import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCursor } from '@cursor';
import { writeModelCache } from '@cursor/catalog';
import CursorPluginModule from '@cursor/plugin';

describe('OpenCode V2 plugin', () => {
	test('shares one hybrid module and registers Cursor from a cached catalog', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-v2-'));
		const previousCache = process.env.XDG_CACHE_HOME;
		Object.assign(process.env, { XDG_CACHE_HOME: directory });
		try {
			await writeModelCache(join(directory, 'opencode'), [
				{
					id: 'fixture-model',
					name: 'Cursor Fixture',
					wireModelId: 'fixture-wire-model',
					maxMode: false,
					contextWindow: 200_000,
					reasoning: true,
					images: false,
				},
			]);

			let integration: Record<string, unknown> | undefined;
			let method: Record<string, unknown> | undefined;
			let provider: Record<string, unknown> | undefined;
			let model: Record<string, unknown> | undefined;
			const setup = Reflect.get(CursorPluginModule, 'setup');
			expect(typeof setup).toBe('function');
			if (typeof setup !== 'function') throw new Error('V2 setup is unavailable');

			const cleanup: unknown = await Reflect.apply(setup, CursorPluginModule, [
				{
					integration: {
						connection: {
							active: async () => undefined,
							resolve: async () => undefined,
						},
						transform: async (apply: (editor: unknown) => void) => {
							apply({
								update(id: string, update: (item: Record<string, unknown>) => void) {
									integration = { id, name: id };
									update(integration);
								},
								method: {
									update(value: Record<string, unknown>) {
										method = value;
									},
								},
							});
						},
					},
					catalog: {
						reload: async () => undefined,
						transform: async (apply: (editor: unknown) => void) => {
							apply({
								provider: {
									update(id: string, update: (item: Record<string, unknown>) => void) {
										provider = { id };
										update(provider);
									},
								},
								model: {
									update(
										providerID: string,
										id: string,
										update: (item: Record<string, unknown>) => void,
									) {
										model = { id, providerID };
										update(model);
									},
								},
							});
						},
					},
				},
			]);

			expect(CursorPluginModule.id).toBe('opencode-cursor-inference');
			expect(typeof CursorPluginModule.server).toBe('function');
			expect(integration).toEqual({ id: 'cursor', name: 'Cursor' });
			expect(method).toMatchObject({
				integrationID: 'cursor',
				method: { id: 'browser', type: 'oauth' },
			});
			const refresh = method?.['refresh'];
			expect(typeof refresh).toBe('function');
			if (typeof refresh !== 'function') throw new Error('V2 OAuth refresh is unavailable');
			const refreshedAccess = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.signature`;
			const previousFetch = globalThis.fetch;
			Object.assign(globalThis, {
				fetch: async () =>
					new Response(JSON.stringify({ access_token: refreshedAccess }), {
						headers: { 'content-type': 'application/json' },
					}),
			});
			try {
				const refreshed: unknown = await Reflect.apply(refresh, undefined, [
					{
						type: 'oauth',
						methodID: 'browser',
						access: 'old-access',
						refresh: 'refresh-token',
						expires: 0,
						metadata: { accountId: 'account-1', enterpriseUrl: 'https://cursor.example' },
					},
				]);
				expect(refreshed).toMatchObject({
					type: 'oauth',
					methodID: 'browser',
					access: refreshedAccess,
					refresh: 'refresh-token',
					metadata: { accountId: 'account-1', enterpriseUrl: 'https://cursor.example' },
				});
			} finally {
				Object.assign(globalThis, { fetch: previousFetch });
			}
			expect(provider).toMatchObject({
				id: 'cursor',
				name: 'Cursor',
				integrationID: 'cursor',
				activation: 'auto',
			});
			expect(model).toMatchObject({
				id: 'fixture-model',
				providerID: 'cursor',
				modelID: 'fixture-model',
				name: 'Cursor Fixture',
				capabilities: { tools: true, input: ['text'], output: ['text'] },
				limit: { context: 200_000, output: 64_000 },
				settings: {
					cursorWireModelId: 'fixture-wire-model',
					cursorMaxMode: false,
				},
			});

			if (typeof cleanup === 'function') await Reflect.apply(cleanup, undefined, []);
		} finally {
			if (previousCache === undefined) Reflect.deleteProperty(process.env, 'XDG_CACHE_HOME');
			else Object.assign(process.env, { XDG_CACHE_HOME: previousCache });
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('OpenCode V2 provider factory', () => {
	test('accepts the injected apiKey and bound catalog selection', () => {
		const provider = createCursor({
			apiKey: 'access-token',
			cacheDir: '/tmp/opencode-cursor-v2-provider',
			cursorWireModelId: 'fixture-wire-model',
			cursorMaxMode: true,
			cursorContext: '1m',
		});
		const model = provider.languageModel('fixture-model');
		expect(model.provider).toBe('cursor');
		expect(model.modelId).toBe('fixture-model');
	});
});
