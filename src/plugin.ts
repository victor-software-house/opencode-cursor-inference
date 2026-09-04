import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type CursorOAuthCredential,
	cursorOAuthMethod,
	isCursorOAuthCredential,
	resolveCursorCredential,
} from '@cursor/auth';
import {
	clearModelCache,
	discoverCursorModels,
	modelsToConfig,
	readFreshModelCache,
	writeModelCache,
} from '@cursor/catalog';
import { isRecord } from '@cursor/guards';
import { disposeCursorProviders } from '@cursor/lifecycle';
import { openCodeCacheDir, openCodeDataDir } from '@cursor/paths';
import type { Plugin, PluginModule } from '@opencode-ai/plugin';

const providerId = 'cursor';
const backendUrl = 'https://api2.cursor.sh';
const providerEntry = new URL('./index.mjs', import.meta.url).href;

async function storedCredential(): Promise<CursorOAuthCredential | undefined> {
	let auth: unknown;
	try {
		const inline = process.env.OPENCODE_AUTH_CONTENT;
		auth =
			inline === undefined || inline === ''
				? JSON.parse(await readFile(join(openCodeDataDir(), 'auth.json'), 'utf8'))
				: JSON.parse(inline);
	} catch {
		return undefined;
	}
	if (!isRecord(auth)) return undefined;
	const cursor = auth[providerId];
	return isCursorOAuthCredential(cursor) ? cursor : undefined;
}

export const CursorPlugin: Plugin = async (input) => {
	const cacheDir = openCodeCacheDir();
	const persist = async (credential: CursorOAuthCredential): Promise<void> => {
		await input.client.auth.set({
			path: { id: providerId },
			body: credential,
		});
	};
	const refreshModels = async (credential: CursorOAuthCredential): Promise<void> => {
		try {
			const resolved = await resolveCursorCredential(credential, persist);
			const models = await discoverCursorModels({ backendUrl, token: resolved.access });
			await writeModelCache(cacheDir, models);
		} catch {
			await clearModelCache(cacheDir);
		}
	};
	const loadModels = async () => {
		const cached = await readFreshModelCache(cacheDir);
		if (cached !== undefined) return modelsToConfig(cached);
		const credential = await storedCredential();
		if (credential === undefined) return {};
		await refreshModels(credential);
		return modelsToConfig((await readFreshModelCache(cacheDir)) ?? []);
	};

	return {
		async dispose() {
			await disposeCursorProviders();
		},
		async config(config) {
			config.provider ??= {};
			config.provider[providerId] = {
				...config.provider[providerId],
				name: 'Cursor',
				npm: providerEntry,
				models: await loadModels(),
			};
		},
		auth: {
			provider: providerId,
			methods: [
				cursorOAuthMethod({
					onSuccess: refreshModels,
				}),
			],
			async loader(getAuth) {
				const credential: unknown = await getAuth();
				if (!isCursorOAuthCredential(credential)) {
					throw new Error('Cursor requires an OpenCode OAuth credential');
				}
				const resolved = await resolveCursorCredential(credential, persist);
				return { accessToken: resolved.access, cacheDir };
			},
		},
	};
};

const CursorPluginModule: PluginModule = {
	id: 'opencode-cursor-inference',
	server: CursorPlugin,
};

export default CursorPluginModule;
