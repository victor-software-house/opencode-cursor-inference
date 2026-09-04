import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCursor } from '@cursor';
import { writeModelCache } from '@cursor/catalog';
import CursorPluginModule, { CursorPlugin } from '@cursor/plugin';

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
					event: {
						async *subscribe(options?: { readonly signal?: AbortSignal }) {
							yield { id: 'event-1', created: 0, type: 'models-dev.refreshed', data: {} };
							if (options?.signal === undefined) return;
							await new Promise<void>((resolve) => {
								options.signal?.addEventListener('abort', () => resolve(), { once: true });
							});
						},
					},
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
				activation: 'enabled',
				body: { apiKey: '' },
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

	test('reloads on logout without refetching the active cached credential', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-v2-events-'));
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
			const credential = {
				type: 'oauth',
				methodID: 'browser',
				access: 'cached-access',
				refresh: 'refresh-token',
				expires: 2_000_000_000_000,
			};
			let reloads = 0;
			let resolveReload: (() => void) | undefined;
			const reloaded = new Promise<void>((resolve) => {
				resolveReload = resolve;
			});
			let provider: Record<string, unknown> | undefined;
			let modelIDs: string[] = [];
			let applyCatalog: ((editor: unknown) => void) | undefined;
			const catalogEditor = {
				provider: {
					update(id: string, update: (item: Record<string, unknown>) => void) {
						provider = { id };
						update(provider);
					},
				},
				model: {
					update(_providerID: string, id: string, update: (item: Record<string, unknown>) => void) {
						modelIDs.push(id);
						update({});
					},
				},
			};
			const setup = Reflect.get(CursorPluginModule, 'setup');
			if (typeof setup !== 'function') throw new Error('V2 setup is unavailable');
			const cleanup: unknown = await Reflect.apply(setup, CursorPluginModule, [
				{
					event: {
						async *subscribe() {
							yield {
								id: 'event-1',
								created: 0,
								type: 'credential.switched',
								data: { integrationID: 'cursor', credentialID: 'cred-1' },
							};
							yield {
								id: 'event-2',
								created: 0,
								type: 'credential.switched',
								data: { integrationID: 'cursor', credentialID: null },
							};
						},
					},
					integration: {
						connection: {
							active: async () => ({ type: 'credential', id: 'cred-1', label: 'Cursor' }),
							resolve: async () => credential,
						},
						transform: async (apply: (editor: unknown) => void) => {
							apply({
								update(_id: string, update: (item: Record<string, unknown>) => void) {
									update({});
								},
								method: { update() {} },
							});
						},
					},
					catalog: {
						async reload() {
							reloads += 1;
							modelIDs = [];
							applyCatalog?.(catalogEditor);
							resolveReload?.();
						},
						async transform(apply: (editor: unknown) => void) {
							applyCatalog = apply;
							modelIDs = [];
							apply(catalogEditor);
						},
					},
				},
			]);

			expect(provider).toMatchObject({ activation: 'auto' });
			expect(modelIDs).toEqual(['fixture-model']);
			await reloaded;
			expect(reloads).toBe(1);
			expect(provider).toMatchObject({
				activation: 'enabled',
				body: { apiKey: '' },
			});
			expect(modelIDs).toEqual(['fixture-model']);
			if (typeof cleanup === 'function') await Reflect.apply(cleanup, undefined, []);
		} finally {
			if (previousCache === undefined) Reflect.deleteProperty(process.env, 'XDG_CACHE_HOME');
			else Object.assign(process.env, { XDG_CACHE_HOME: previousCache });
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('OpenCode stable V1 adapter', () => {
	test('exposes exactly default Auto before login', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-v1-auto-'));
		const previousCache = process.env.XDG_CACHE_HOME;
		const previousData = process.env.XDG_DATA_HOME;
		Object.assign(process.env, { XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory });
		try {
			const hooks: unknown = await Reflect.apply(CursorPlugin, undefined, [
				{ client: { auth: { set: async () => undefined } } },
			]);
			if (hooks === null || typeof hooks !== 'object') throw new Error('V1 hooks are unavailable');
			const configure = Reflect.get(hooks, 'config');
			if (typeof configure !== 'function') throw new Error('V1 config hook is unavailable');
			const config: Record<string, unknown> = {};
			await Reflect.apply(configure, hooks, [config]);
			expect(config).toMatchObject({
				provider: {
					cursor: {
						models: {
							default: {
								id: 'default',
								name: 'Auto',
								options: { cursorWireModelId: 'default', cursorMaxMode: false },
							},
						},
					},
				},
			});
		} finally {
			if (previousCache === undefined) Reflect.deleteProperty(process.env, 'XDG_CACHE_HOME');
			else Object.assign(process.env, { XDG_CACHE_HOME: previousCache });
			if (previousData === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME');
			else Object.assign(process.env, { XDG_DATA_HOME: previousData });
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('retains a stale authenticated snapshot after logout', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-v1-stale-'));
		const previousCache = process.env.XDG_CACHE_HOME;
		const previousData = process.env.XDG_DATA_HOME;
		Object.assign(process.env, { XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory });
		try {
			await writeModelCache(
				join(directory, 'opencode'),
				[
					{
						id: 'last-known',
						name: 'Last Known',
						wireModelId: 'last-known-wire',
						maxMode: false,
						contextWindow: 200_000,
						reasoning: false,
						images: false,
					},
				],
				0,
			);
			const hooks: unknown = await Reflect.apply(CursorPlugin, undefined, [
				{ client: { auth: { set: async () => undefined } } },
			]);
			if (hooks === null || typeof hooks !== 'object') throw new Error('V1 hooks are unavailable');
			const configure = Reflect.get(hooks, 'config');
			if (typeof configure !== 'function') throw new Error('V1 config hook is unavailable');
			const config: Record<string, unknown> = {};
			await Reflect.apply(configure, hooks, [config]);
			expect(config).toMatchObject({
				provider: {
					cursor: {
						models: {
							'last-known': {
								id: 'last-known',
								name: 'Last Known',
							},
						},
					},
				},
			});
		} finally {
			if (previousCache === undefined) Reflect.deleteProperty(process.env, 'XDG_CACHE_HOME');
			else Object.assign(process.env, { XDG_CACHE_HOME: previousCache });
			if (previousData === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME');
			else Object.assign(process.env, { XDG_DATA_HOME: previousData });
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
