import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type CursorOAuthCredential,
	createCursorOAuthFlow,
	cursorOAuthMethod,
	isCursorOAuthCredential,
	refreshCursorToken,
	resolveCursorCredential,
} from '@cursor/auth';
import {
	CursorCatalogState,
	type DiscoveredModel,
	discoverCursorModels,
	modelsToConfig,
	readFreshModelCache,
	readLastKnownModelCache,
	writeModelCache,
} from '@cursor/catalog';
import { disposeCursorProviders } from '@cursor/lifecycle';
import { openCodeCacheDir, openCodeDataDir } from '@cursor/paths';
import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import type { Context as V2PluginContext } from '@opencode-ai/plugin-v2/promise/plugin';
import { define as defineV2 } from '@opencode-ai/plugin-v2/promise/plugin';
import { Credential } from '@opencode-ai/schema-v2/credential';
import { Integration } from '@opencode-ai/schema-v2/integration';
import { Model } from '@opencode-ai/schema-v2/model';
import { Provider } from '@opencode-ai/schema-v2/provider';
import { isRecord, omitUndefined } from '@victor-software-house/pi-type-kit';

const providerId = 'cursor';
const v2ProviderId = Provider.ID.make(providerId);
const v2IntegrationId = Integration.ID.make(providerId);
const v2OAuthMethodId = Integration.MethodID.make('browser');
const backendUrl = 'https://api2.cursor.sh';
const providerEntry = new URL('./index.mjs', import.meta.url).href;
const v2ProviderEntry = `aisdk:${providerEntry}`;
const outputTokenLimit = 64_000;

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

async function discoverModels(credential: CursorOAuthCredential): Promise<DiscoveredModel[]> {
	return await discoverCursorModels({ backendUrl, token: credential.access });
}

function v2OAuthCredential(
	credential: CursorOAuthCredential,
	metadata?: Readonly<Record<string, unknown>>,
): Credential.OAuth {
	const cursorMetadata = omitUndefined({
		accountId: credential.accountId,
		enterpriseUrl: credential.enterpriseUrl,
	});
	const mergedMetadata = { ...metadata, ...cursorMetadata };
	return Credential.OAuth.make({
		type: 'oauth',
		methodID: v2OAuthMethodId,
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
		...(Object.keys(mergedMetadata).length === 0 ? {} : { metadata: mergedMetadata }),
	});
}

export const CursorPlugin: Plugin = async (input) => {
	const cacheDir = openCodeCacheDir();
	const freshModels = await readFreshModelCache(cacheDir);
	const catalog = new CursorCatalogState(freshModels ?? (await readLastKnownModelCache(cacheDir)));
	let catalogFresh = freshModels !== undefined;
	const persist = async (credential: CursorOAuthCredential): Promise<void> => {
		await input.client.auth.set({
			path: { id: providerId },
			body: credential,
		});
	};
	const refreshModels = async (credential: CursorOAuthCredential): Promise<void> => {
		try {
			const resolved = await resolveCursorCredential(credential, persist);
			await catalog.refresh(
				async () => await discoverModels(resolved),
				async (models) => await writeModelCache(cacheDir, models),
			);
			catalogFresh = true;
		} catch {}
	};
	const loadModels = async () => {
		const credential = await storedCredential();
		if (credential === undefined) return modelsToConfig(catalog.models(false));
		if (!catalogFresh) await refreshModels(credential);
		return modelsToConfig(catalog.models(true));
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

type CursorV2Context = {
	readonly catalog: Pick<V2PluginContext['catalog'], 'reload' | 'transform'>;
	readonly event: Pick<V2PluginContext['event'], 'subscribe'>;
	readonly integration: Pick<V2PluginContext['integration'], 'connection' | 'transform'>;
};

async function setupCursorV2(input: CursorV2Context): Promise<() => Promise<void>> {
	const cacheDir = openCodeCacheDir();
	const freshModels = await readFreshModelCache(cacheDir);
	const catalog = new CursorCatalogState(freshModels ?? (await readLastKnownModelCache(cacheDir)));
	let hasCredential = false;
	let loadedCredentialAccess: string | undefined;

	const loadModels = async (credential: CursorOAuthCredential): Promise<void> => {
		await catalog.refresh(
			async () => await discoverModels(credential),
			async (models) => await writeModelCache(cacheDir, models),
		);
		loadedCredentialAccess = credential.access;
	};
	const refreshModels = async (credential: CursorOAuthCredential): Promise<void> => {
		try {
			await loadModels(credential);
		} finally {
			await input.catalog.reload();
		}
	};

	await input.integration.transform((editor) => {
		editor.update(v2IntegrationId, (integration) => {
			integration.name = 'Cursor';
		});
		editor.method.update({
			integrationID: v2IntegrationId,
			method: {
				id: v2OAuthMethodId,
				type: 'oauth',
				label: 'Cursor account (browser login)',
			},
			async authorize() {
				const flow = createCursorOAuthFlow();
				return {
					mode: 'auto',
					url: flow.url,
					instructions: flow.instructions,
					callback: flow.callback().then(async (credential) => {
						hasCredential = true;
						await refreshModels(credential).catch(() => undefined);
						return v2OAuthCredential(credential);
					}),
				};
			},
			async refresh(credential) {
				if (!isCursorOAuthCredential(credential)) {
					throw new Error('Cursor requires an OpenCode OAuth credential');
				}
				const refreshed = await refreshCursorToken(credential);
				return v2OAuthCredential(refreshed, credential.metadata);
			},
		});
	});

	const connection = await input.integration.connection.active(v2IntegrationId);
	const credential =
		connection === undefined ? undefined : await input.integration.connection.resolve(connection);
	hasCredential = connection !== undefined;
	if (isCursorOAuthCredential(credential)) {
		loadedCredentialAccess = credential.access;
		if (freshModels === undefined) await loadModels(credential).catch(() => undefined);
	}

	await input.catalog.transform((catalogEditor) => {
		catalogEditor.provider.update(v2ProviderId, (provider) => {
			provider.name = 'Cursor';
			provider.integrationID = v2IntegrationId;
			provider.activation = hasCredential ? 'auto' : 'enabled';
			provider.package = v2ProviderEntry;
			provider.body = hasCredential ? {} : { apiKey: '' };
			provider.settings = { cacheDir };
		});
		for (const discovered of catalog.models(hasCredential)) {
			catalogEditor.model.update(v2ProviderId, Model.ID.make(discovered.id), (model) => {
				model.modelID = Model.ID.make(discovered.id);
				model.name = discovered.name;
				model.capabilities = {
					tools: true,
					input: discovered.images ? ['text', 'image'] : ['text'],
					output: ['text'],
				};
				model.limit = { context: discovered.contextWindow, output: outputTokenLimit };
				model.settings = {
					cursorWireModelId: discovered.wireModelId,
					cursorMaxMode: discovered.maxMode,
					...(discovered.context === undefined ? {} : { cursorContext: discovered.context }),
				};
			});
		}
	});

	const eventController = new AbortController();
	const eventLoop = (async () => {
		for await (const event of input.event.subscribe({ signal: eventController.signal })) {
			if (event.type !== 'credential.switched' || event.data.integrationID !== v2IntegrationId) {
				continue;
			}
			try {
				if (event.data.credentialID === null) {
					hasCredential = false;
					loadedCredentialAccess = undefined;
					await input.catalog.reload();
					continue;
				}
				const active = await input.integration.connection.active(v2IntegrationId);
				const activeCredential =
					active === undefined ? undefined : await input.integration.connection.resolve(active);
				if (!isCursorOAuthCredential(activeCredential)) {
					hasCredential = true;
					loadedCredentialAccess = undefined;
					await input.catalog.reload();
					continue;
				}
				hasCredential = true;
				if (activeCredential.access === loadedCredentialAccess) continue;
				await refreshModels(activeCredential).catch(() => undefined);
			} catch {}
		}
	})().catch(() => undefined);

	return async () => {
		eventController.abort();
		await eventLoop;
		await disposeCursorProviders();
	};
}

const CursorV2Plugin = defineV2({
	id: 'opencode-cursor-inference',
	setup: setupCursorV2,
});

const CursorPluginModule: PluginModule = Object.assign(CursorV2Plugin, {
	server: CursorPlugin,
});

export default CursorPluginModule;
