import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type {
	GetDefaultModelForCliResponse,
	GetUsableModelsResponse,
	ModelDetails,
} from '@cursor/gen/agent/v1/catalog_pb';
import {
	GetDefaultModelForCliRequestSchema,
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
} from '@cursor/gen/agent/v1/catalog_pb';
import type {
	AvailableModelsResponse,
	AvailableModelsResponse_AvailableModel,
} from '@cursor/gen/aiserver/v1/catalog_pb';
import {
	AvailableModelsRequestSchema,
	AvailableModelsResponseSchema,
} from '@cursor/gen/aiserver/v1/catalog_pb';
import { thrownMessage as errorMessage, isRecord } from '@victor-software-house/pi-type-kit';

const service = 'aiserver.v1.AiService';
const clientVersion = 'cli-2026.09.02-fa0c06e-lab';
const responseLimit = 4 * 1024 * 1024;
const timeoutMs = 10_000;
const defaultContextWindow = 200_000;
const defaultOutputTokens = 64_000;
const cacheSchemaVersion = 1;
const cacheTtlMs = 10 * 60 * 1_000;
const effortSuffix = /^(.*)-(none|minimal|low|medium|high|xhigh|extra-high|max)(-fast)?$/u;
const preferredEfforts = ['medium', 'high', 'low', 'minimal', 'xhigh', 'extra-high', 'max', 'none'];

export type CursorHttpRequest = (
	options: RequestOptions,
	callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface CursorCatalogOptions {
	readonly backendUrl: string;
	readonly token: string;
	readonly signal?: AbortSignal;
	readonly request?: CursorHttpRequest;
}

export interface DiscoveredModel {
	readonly id: string;
	readonly name: string;
	readonly wireModelId: string;
	readonly maxMode: boolean;
	readonly context?: string;
	readonly contextWindow: number;
	readonly reasoning: boolean;
	readonly images: boolean;
}

export const CURSOR_AUTO_MODEL: DiscoveredModel = {
	id: 'default',
	name: 'Auto',
	wireModelId: 'default',
	maxMode: false,
	contextWindow: defaultContextWindow,
	reasoning: false,
	images: false,
};

export class CursorCatalogState {
	#authenticated: DiscoveredModel[] | undefined;

	constructor(authenticated?: readonly DiscoveredModel[]) {
		this.#authenticated = authenticated === undefined ? undefined : [...authenticated];
	}

	models(hasCredential: boolean): readonly DiscoveredModel[] {
		if (this.#authenticated !== undefined) return this.#authenticated;
		return hasCredential ? [] : [CURSOR_AUTO_MODEL];
	}

	async refresh(
		load: () => Promise<readonly DiscoveredModel[]>,
		persist: (models: readonly DiscoveredModel[]) => Promise<void>,
	): Promise<void> {
		const discovered = await load();
		if (discovered.length === 0) {
			throw new Error('Cursor authenticated catalog returned no models');
		}
		await persist(discovered);
		this.#authenticated = [...discovered];
	}
}

export interface OpenCodeModelConfig {
	readonly id: string;
	readonly name: string;
	readonly reasoning: boolean;
	readonly attachment: boolean;
	readonly tool_call: true;
	readonly temperature: true;
	readonly modalities: {
		readonly input: Array<'text' | 'image'>;
		readonly output: ['text'];
	};
	readonly limit: { readonly context: number; readonly output: number };
	readonly cost: {
		readonly input: 0;
		readonly output: 0;
		readonly cache_read: 0;
		readonly cache_write: 0;
	};
	readonly options: {
		readonly cursorWireModelId: string;
		readonly cursorMaxMode: boolean;
		readonly cursorContext?: string;
	};
}

interface ModelCache {
	readonly schemaVersion: number;
	readonly fetchedAt: number;
	readonly models: DiscoveredModel[];
}

interface ModelFamily {
	readonly id: string;
	readonly members: Array<{ readonly model: ModelDetails; readonly effort?: string }>;
}

function backendOrigin(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error('Cursor backend authority is invalid', { cause: error });
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		(url.pathname !== '' && url.pathname !== '/') ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new Error('Cursor backend authority must be an HTTPS origin');
	}
	return new URL(url.origin);
}

function decoded(body: Uint8Array, encoding: string | undefined): Uint8Array {
	if (encoding === 'gzip') return new Uint8Array(gunzipSync(body));
	if (encoding === 'br') return new Uint8Array(brotliDecompressSync(body));
	return body;
}

function unary<Request extends DescMessage, Response extends DescMessage>(
	method: string,
	request: { readonly schema: Request; readonly message: MessageShape<Request> },
	response: Response,
	options: CursorCatalogOptions,
): Promise<MessageShape<Response>> {
	const origin = backendOrigin(options.backendUrl);
	const body = toBinary(request.schema, request.message);
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted === true) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const send = options.request ?? httpsRequest;
		const outgoing = send(
			{
				protocol: 'https:',
				host: origin.hostname,
				port: origin.port === '' ? 443 : origin.port,
				path: `/${service}/${method}`,
				method: 'POST',
				headers: {
					'accept-encoding': 'gzip,br',
					authorization: `Bearer ${options.token}`,
					'connect-protocol-version': '1',
					'content-type': 'application/proto',
					'user-agent': 'connect-es/1.6.1',
					'x-cursor-client-type': 'cli',
					'x-cursor-client-version': clientVersion,
					'x-ghost-mode': 'false',
					'x-request-id': crypto.randomUUID(),
					...(body.length === 0 ? { 'content-length': '0' } : {}),
				},
			},
			(incoming) => {
				const chunks: Uint8Array[] = [];
				let size = 0;
				incoming.on('data', (chunk: Uint8Array) => {
					size += chunk.length;
					if (size > responseLimit) {
						outgoing.destroy(new Error('Cursor catalog response exceeded its size limit'));
						return;
					}
					chunks.push(chunk);
				});
				incoming.on('end', () => {
					if (incoming.statusCode !== 200) {
						reject(new Error(`Cursor ${method} returned HTTP ${String(incoming.statusCode ?? 0)}`));
						return;
					}
					try {
						const bytes = decoded(Buffer.concat(chunks), incoming.headers['content-encoding']);
						resolve(fromBinary(response, bytes));
					} catch (error) {
						reject(new Error(`Cursor ${method} returned invalid protobuf: ${errorMessage(error)}`));
					}
				});
				incoming.on('error', reject);
			},
		);
		outgoing.on('error', reject);
		outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`Cursor ${method} timed out`)));
		const signal = options.signal;
		if (signal !== undefined) {
			const abort = (): void => {
				outgoing.destroy(new DOMException('Aborted', 'AbortError'));
			};
			signal.addEventListener('abort', abort, { once: true });
			outgoing.on('close', () => signal.removeEventListener('abort', abort));
		}
		if (body.length === 0) outgoing.end();
		else {
			outgoing.write(body);
			outgoing.end();
		}
	});
}

function displayName(model: ModelDetails): string {
	return model.displayName || model.displayNameShort || model.displayModelId || model.modelId;
}

function familyFor(model: ModelDetails): { readonly id: string; readonly effort?: string } {
	const matched = effortSuffix.exec(model.modelId);
	const base = matched?.[1];
	const effort = matched?.[2];
	const fast = matched?.[3] === '-fast';
	return base === undefined || effort === undefined
		? { id: model.modelId }
		: { id: `${base}${fast ? '-fast' : ''}`, effort };
}

function modelFamilies(models: readonly ModelDetails[]): ModelFamily[] {
	const grouped = new Map<string, ModelFamily['members']>();
	for (const model of models) {
		if (model.modelId === '') continue;
		const member = familyFor(model);
		const members = grouped.get(member.id) ?? [];
		members.push({ model, ...(member.effort === undefined ? {} : { effort: member.effort }) });
		grouped.set(member.id, members);
	}
	return [...grouped].map(([id, members]) => ({ id, members }));
}

function baseModelFor(
	family: ModelFamily,
	models: readonly AvailableModelsResponse_AvailableModel[],
): AvailableModelsResponse_AvailableModel | undefined {
	const memberIds = new Set(family.members.map(({ model }) => model.modelId));
	return models.find(
		(candidate) =>
			candidate.name === family.id ||
			candidate.idAliases.includes(family.id) ||
			candidate.legacySlugs.some((slug) => memberIds.has(slug)) ||
			candidate.variants.some((variant) =>
				variant.legacySlug === undefined ? false : memberIds.has(variant.legacySlug),
			),
	);
}

function tooltipText(model: AvailableModelsResponse_AvailableModel, maxMode: boolean): string {
	const tooltip = maxMode ? model.tooltipDataForMaxMode : model.tooltipData;
	return tooltip === undefined
		? ''
		: [
				tooltip.primaryText,
				tooltip.secondaryText,
				tooltip.tertiaryText,
				tooltip.markdownContent ?? '',
			].join('\n');
}

function hasDistinctMaxMode(model: AvailableModelsResponse_AvailableModel): boolean {
	if (model.supportsMaxMode !== true) return false;
	if (model.supportsNonMaxMode === false) return true;
	if (
		model.contextTokenLimitForMaxMode !== undefined &&
		model.contextTokenLimitForMaxMode !== model.contextTokenLimit
	) {
		return true;
	}
	if (tooltipText(model, true) !== tooltipText(model, false)) return true;
	if (model.variants.some((variant) => variant.isMaxMode)) return true;
	const normal = model.variants.find((variant) => variant.isDefaultNonMaxConfig === true);
	const max = model.variants.find((variant) => variant.isDefaultMaxConfig === true);
	return normal !== undefined && max !== undefined && normal !== max;
}

function variantContext(
	model: AvailableModelsResponse_AvailableModel,
	maxMode: boolean,
): string | undefined {
	const variant = model.variants.find((candidate) =>
		maxMode ? candidate.isDefaultMaxConfig === true : candidate.isDefaultNonMaxConfig === true,
	);
	return variant?.parameterValues.find((parameter) => parameter.id === 'context')?.value;
}

function contextParameterTokens(value: string | undefined): number | undefined {
	const matched = /^(\d+(?:\.\d+)?)([km])$/u.exec(value ?? '');
	if (matched === null) return undefined;
	const amount = Number(matched[1]);
	const multiplier = matched[2] === 'm' ? 1_000_000 : 1_000;
	const tokens = amount * multiplier;
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function contextWindow(model: AvailableModelsResponse_AvailableModel, maxMode: boolean): number {
	const selected = contextParameterTokens(variantContext(model, maxMode));
	if (selected !== undefined) return selected;
	const captured = maxMode
		? (model.contextTokenLimitForMaxMode ?? model.contextTokenLimit)
		: model.contextTokenLimit;
	return captured !== undefined && captured > 0 ? captured : defaultContextWindow;
}

function representative(family: ModelFamily): ModelDetails {
	const selected =
		preferredEfforts.flatMap((effort) =>
			family.members.filter((member) => member.effort === effort),
		)[0]?.model ?? family.members[0]?.model;
	if (selected === undefined) throw new Error(`Cursor model family '${family.id}' is empty`);
	return selected;
}

function discoveredModel(
	family: ModelFamily,
	base: AvailableModelsResponse_AvailableModel,
	maxMode: boolean,
): DiscoveredModel {
	const selection = representative(family);
	const context = variantContext(base, maxMode);
	const capturedName =
		base.clientDisplayName === undefined || base.clientDisplayName === ''
			? displayName(selection).replace(
					/ (?:None|Minimal|Low|Medium|High|Extra High|Max)(?= Fast$|$)/u,
					'',
				)
			: base.clientDisplayName;
	return {
		id: `${family.id}${maxMode ? '-max' : ''}`,
		name: `${capturedName}${maxMode ? ' Max' : ''}`,
		wireModelId: selection.modelId,
		maxMode,
		...(context === undefined ? {} : { context }),
		contextWindow: contextWindow(base, maxMode),
		reasoning: base.supportsThinking === true,
		images: base.supportsImages === true,
	};
}

export function catalogModels(
	base: AvailableModelsResponse,
	usable: GetUsableModelsResponse,
	defaultModel: GetDefaultModelForCliResponse,
): DiscoveredModel[] {
	if (base.models.length === 0) throw new Error('Cursor AvailableModels returned no models');
	const models = modelFamilies(usable.models).flatMap((family) => {
		const metadata = baseModelFor(family, base.models);
		if (metadata === undefined) return [];
		return [
			...(metadata.supportsNonMaxMode === false ? [] : [discoveredModel(family, metadata, false)]),
			...(hasDistinctMaxMode(metadata) ? [discoveredModel(family, metadata, true)] : []),
		];
	});
	if (models.length === 0)
		throw new Error('Cursor catalog returned no fully described usable models');
	const defaultSelection = defaultModel.model;
	if (defaultSelection !== undefined && defaultSelection.modelId !== '') {
		const usableIds = new Set(usable.models.map(({ modelId }) => modelId));
		if (!usableIds.has(defaultSelection.modelId)) {
			throw new Error(`Cursor default model '${defaultSelection.modelId}' is not usable`);
		}
		const defaultFamily = familyFor(defaultSelection).id;
		if (!models.some(({ id }) => id === defaultFamily || id === `${defaultFamily}-max`)) {
			throw new Error(
				`Cursor default model '${defaultSelection.modelId}' has no complete catalog metadata`,
			);
		}
	}
	return models;
}

export async function discoverCursorModels(
	options: CursorCatalogOptions,
): Promise<DiscoveredModel[]> {
	if (options.token.includes('\r') || options.token.includes('\n')) {
		throw new Error('Cursor credential contains a line break');
	}
	const [base, usable, defaultModel] = await Promise.all([
		unary(
			'AvailableModels',
			{
				schema: AvailableModelsRequestSchema,
				message: create(AvailableModelsRequestSchema, {
					useModelParameters: true,
					doNotUseMarkdown: true,
				}),
			},
			AvailableModelsResponseSchema,
			options,
		),
		unary(
			'GetUsableModels',
			{ schema: GetUsableModelsRequestSchema, message: create(GetUsableModelsRequestSchema) },
			GetUsableModelsResponseSchema,
			options,
		),
		unary(
			'GetDefaultModelForCli',
			{
				schema: GetDefaultModelForCliRequestSchema,
				message: create(GetDefaultModelForCliRequestSchema),
			},
			GetDefaultModelForCliResponseSchema,
			options,
		),
	]);
	return catalogModels(base, usable, defaultModel);
}

export function modelsToConfig(
	models: readonly DiscoveredModel[],
): Record<string, OpenCodeModelConfig> {
	return Object.fromEntries(
		models.map((model) => [
			model.id,
			{
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				attachment: model.images,
				tool_call: true,
				temperature: true,
				modalities: { input: model.images ? ['text', 'image'] : ['text'], output: ['text'] },
				limit: { context: model.contextWindow, output: defaultOutputTokens },
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				options: {
					cursorWireModelId: model.wireModelId,
					cursorMaxMode: model.maxMode,
					...(model.context === undefined ? {} : { cursorContext: model.context }),
				},
			} satisfies OpenCodeModelConfig,
		]),
	);
}

function cachePath(cacheDir: string): string {
	return join(cacheDir, 'cursor-inference', 'models.json');
}

function parseDiscoveredModel(value: unknown): DiscoveredModel | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value['id'] !== 'string' ||
		value['id'] === '' ||
		typeof value['name'] !== 'string' ||
		value['name'] === '' ||
		typeof value['wireModelId'] !== 'string' ||
		value['wireModelId'] === '' ||
		typeof value['maxMode'] !== 'boolean' ||
		typeof value['contextWindow'] !== 'number' ||
		!Number.isSafeInteger(value['contextWindow']) ||
		value['contextWindow'] <= 0 ||
		typeof value['reasoning'] !== 'boolean' ||
		typeof value['images'] !== 'boolean' ||
		(value['context'] !== undefined && typeof value['context'] !== 'string')
	) {
		return undefined;
	}
	return {
		id: value['id'],
		name: value['name'],
		wireModelId: value['wireModelId'],
		maxMode: value['maxMode'],
		...(value['context'] === undefined ? {} : { context: value['context'] }),
		contextWindow: value['contextWindow'],
		reasoning: value['reasoning'],
		images: value['images'],
	};
}

function parseCache(value: unknown): ModelCache | undefined {
	if (
		!isRecord(value) ||
		value['schemaVersion'] !== cacheSchemaVersion ||
		typeof value['fetchedAt'] !== 'number' ||
		!Number.isFinite(value['fetchedAt']) ||
		!Array.isArray(value['models']) ||
		value['models'].length === 0
	) {
		return undefined;
	}
	const models = value['models'].map(parseDiscoveredModel);
	if (models.some((model) => model === undefined)) return undefined;
	const authenticated = models.filter((model): model is DiscoveredModel => model !== undefined);
	if (new Set(authenticated.map((model) => model.id)).size !== authenticated.length) {
		return undefined;
	}
	return {
		schemaVersion: cacheSchemaVersion,
		fetchedAt: value['fetchedAt'],
		models: authenticated,
	};
}

async function readModelCache(cacheDir: string): Promise<ModelCache | undefined> {
	try {
		return parseCache(JSON.parse(await readFile(cachePath(cacheDir), 'utf8')));
	} catch {
		return undefined;
	}
}

export async function readLastKnownModelCache(
	cacheDir: string,
): Promise<DiscoveredModel[] | undefined> {
	return (await readModelCache(cacheDir))?.models;
}

export async function readFreshModelCache(
	cacheDir: string,
	now: number = Date.now(),
): Promise<DiscoveredModel[] | undefined> {
	const cache = await readModelCache(cacheDir);
	if (cache === undefined || now - cache.fetchedAt >= cacheTtlMs) return undefined;
	return cache.models;
}

export async function writeModelCache(
	cacheDir: string,
	models: readonly DiscoveredModel[],
	now: number = Date.now(),
): Promise<void> {
	const path = cachePath(cacheDir);
	const directory = join(cacheDir, 'cursor-inference');
	const temporary = join(directory, `.models-${randomUUID()}.tmp`);
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({ schemaVersion: cacheSchemaVersion, fetchedAt: now, models }, undefined, 2)}\n`,
			{ encoding: 'utf8', mode: 0o600 },
		);
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}
