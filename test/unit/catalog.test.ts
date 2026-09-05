import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
	CURSOR_AUTO_MODEL,
	CursorCatalogState,
	catalogModels,
	modelsToConfig,
	readFreshModelCache,
	readLastKnownModelCache,
	writeModelCache,
} from '@cursor/catalog';
import {
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsResponseSchema,
	ModelDetailsSchema,
} from '@cursor/gen/agent/v1/catalog_pb';
import {
	AvailableModelsResponse_AvailableModelSchema,
	AvailableModelsResponseSchema,
} from '@cursor/gen/aiserver/v1/catalog_pb';

function parameters(options: {
	readonly context: '200k' | '1m';
	readonly effort: 'none' | 'medium' | 'max';
	readonly fast: boolean;
}) {
	return [
		{ id: 'thinking', value: options.effort === 'none' ? 'false' : 'true' },
		{ id: 'context', value: options.context },
		{ id: 'effort', value: options.effort === 'none' ? 'medium' : options.effort },
		{ id: 'fast', value: String(options.fast) },
	];
}

function route(
	legacySlug: string,
	options: {
		readonly context: '200k' | '1m';
		readonly effort: 'none' | 'medium' | 'max';
		readonly fast: boolean;
		readonly maxMode: boolean;
		readonly defaultMode?: 'normal' | 'max';
	},
) {
	return {
		legacySlug,
		isMaxMode: options.maxMode,
		isDefaultNonMaxConfig: options.defaultMode === 'normal',
		isDefaultMaxConfig: options.defaultMode === 'max',
		parameterValues: parameters(options),
	};
}

const usableModels = [
	create(ModelDetailsSchema, { modelId: 'reasoner-none', displayName: 'Reasoner None' }),
	create(ModelDetailsSchema, { modelId: 'reasoner-medium', displayName: 'Reasoner Medium' }),
	create(ModelDetailsSchema, { modelId: 'reasoner-max', displayName: 'Reasoner Max' }),
	create(ModelDetailsSchema, {
		modelId: 'reasoner-medium-fast',
		displayName: 'Reasoner Medium Fast',
	}),
	create(ModelDetailsSchema, { modelId: 'reasoner-max-fast', displayName: 'Reasoner Max Fast' }),
];

const base = create(AvailableModelsResponseSchema, {
	models: [
		create(AvailableModelsResponse_AvailableModelSchema, {
			name: 'reasoner-server',
			serverModelName: 'reasoner-wire',
			clientDisplayName: 'Reasoner',
			legacySlugs: usableModels.map(({ modelId }) => modelId),
			supportsThinking: true,
			supportsImages: true,
			supportsMaxMode: true,
			supportsNonMaxMode: true,
			contextTokenLimit: 200_000,
			contextTokenLimitForMaxMode: 1_000_000,
			variants: [
				route('reasoner-none', {
					context: '200k',
					effort: 'none',
					fast: false,
					maxMode: false,
				}),
				route('reasoner-medium', {
					context: '200k',
					effort: 'medium',
					fast: false,
					maxMode: false,
					defaultMode: 'normal',
				}),
				route('reasoner-max', {
					context: '200k',
					effort: 'max',
					fast: false,
					maxMode: false,
				}),
				route('reasoner-medium-fast', {
					context: '200k',
					effort: 'medium',
					fast: true,
					maxMode: false,
				}),
				route('reasoner-max-fast', {
					context: '200k',
					effort: 'max',
					fast: true,
					maxMode: false,
				}),
				route('reasoner-none', {
					context: '1m',
					effort: 'none',
					fast: false,
					maxMode: true,
				}),
				route('reasoner-medium', {
					context: '1m',
					effort: 'medium',
					fast: false,
					maxMode: true,
					defaultMode: 'max',
				}),
				route('reasoner-max', {
					context: '1m',
					effort: 'max',
					fast: false,
					maxMode: true,
				}),
				route('reasoner-medium-fast', {
					context: '1m',
					effort: 'medium',
					fast: true,
					maxMode: true,
				}),
				route('reasoner-max-fast', {
					context: '1m',
					effort: 'max',
					fast: true,
					maxMode: true,
				}),
			],
		}),
	],
});
const usable = create(GetUsableModelsResponseSchema, { models: usableModels });
const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usableModels[1] });

function discovered() {
	return catalogModels(base, usable, defaultModel);
}

describe('Cursor catalog', () => {
	test('separates Fast and Max rows while keeping reasoning efforts as variants', () => {
		const models = discovered();
		expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: 'reasoner', name: 'Reasoner' },
			{ id: 'reasoner-max', name: 'Reasoner Max' },
			{ id: 'reasoner-fast', name: 'Reasoner Fast' },
			{ id: 'reasoner-fast-max', name: 'Reasoner Fast Max' },
		]);
		expect(new Set(models.map(({ name }) => name)).size).toBe(models.length);
		expect(models[0]).toMatchObject({
			wireModelId: 'reasoner-wire',
			maxMode: false,
			parameters: parameters({ context: '200k', effort: 'medium', fast: false }),
			variants: [{ id: 'none' }, { id: 'medium' }, { id: 'max' }],
			contextWindow: 200_000,
			reasoning: true,
			images: true,
		});
		expect(models[1]).toMatchObject({
			maxMode: true,
			parameters: parameters({ context: '1m', effort: 'medium', fast: false }),
			contextWindow: 1_000_000,
		});
		expect(models[2]).toMatchObject({
			maxMode: false,
			parameters: parameters({ context: '200k', effort: 'medium', fast: true }),
		});
		expect(models[3]).toMatchObject({
			maxMode: true,
			parameters: parameters({ context: '1m', effort: 'medium', fast: true }),
		});
	});

	test('maps complete row and effort routes into stable OpenCode model options', () => {
		const config = modelsToConfig(discovered());
		expect(config['reasoner-max']).toMatchObject({
			reasoning: true,
			attachment: true,
			limit: { context: 1_000_000, output: 64_000 },
			options: {
				cursorWireModelId: 'reasoner-wire',
				cursorMaxMode: true,
				cursorModelParameters: parameters({
					context: '1m',
					effort: 'medium',
					fast: false,
				}),
			},
			variants: {
				max: {
					cursorWireModelId: 'reasoner-wire',
					cursorMaxMode: true,
					cursorModelParameters: parameters({
						context: '1m',
						effort: 'max',
						fast: false,
					}),
				},
			},
		});
	});

	test('uses captured non-Max parameters when Max has no separate variant table', () => {
		const family = create(AvailableModelsResponseSchema, {
			models: [
				create(AvailableModelsResponse_AvailableModelSchema, {
					name: 'fast-reasoner',
					serverModelName: 'fast-reasoner-wire',
					clientDisplayName: 'Fast Reasoner',
					legacySlugs: ['fast-reasoner-medium', 'fast-reasoner-high-fast'],
					supportsThinking: true,
					supportsMaxMode: true,
					supportsNonMaxMode: true,
					variants: [
						{
							legacySlug: 'fast-reasoner-medium',
							isDefaultNonMaxConfig: true,
							parameterValues: [
								{ id: 'reasoning', value: 'medium' },
								{ id: 'fast', value: 'false' },
							],
						},
						{
							legacySlug: 'fast-reasoner-high-fast',
							isDefaultMaxConfig: true,
							parameterValues: [
								{ id: 'reasoning', value: 'high' },
								{ id: 'fast', value: 'true' },
							],
						},
					],
				}),
			],
		});
		const rows = catalogModels(
			family,
			create(GetUsableModelsResponseSchema, {
				models: [
					create(ModelDetailsSchema, { modelId: 'fast-reasoner-medium' }),
					create(ModelDetailsSchema, { modelId: 'fast-reasoner-high-fast' }),
				],
			}),
			create(GetDefaultModelForCliResponseSchema),
		);
		expect(rows.map(({ id }) => id)).toEqual([
			'fast-reasoner',
			'fast-reasoner-max',
			'fast-reasoner-fast',
			'fast-reasoner-fast-max',
		]);
		expect(rows[1]).toMatchObject({
			wireModelId: 'fast-reasoner-wire',
			maxMode: true,
			parameters: [
				{ id: 'reasoning', value: 'medium' },
				{ id: 'fast', value: 'false' },
			],
		});
		expect(rows[3]).toMatchObject({
			wireModelId: 'fast-reasoner-wire',
			maxMode: true,
			parameters: [
				{ id: 'reasoning', value: 'high' },
				{ id: 'fast', value: 'true' },
			],
		});
	});

	test('keeps an explicit Max-only default without synthesizing a normal row', () => {
		const maxOnly = create(ModelDetailsSchema, {
			modelId: 'max-only-high',
			displayName: 'Max Only High',
			maxMode: true,
		});
		const rows = catalogModels(
			create(AvailableModelsResponseSchema, {
				models: [
					create(AvailableModelsResponse_AvailableModelSchema, {
						name: 'max-only',
						serverModelName: 'max-only-wire',
						clientDisplayName: 'Max Only',
						legacySlugs: [maxOnly.modelId],
						supportsThinking: true,
						supportsMaxMode: true,
						supportsNonMaxMode: false,
						contextTokenLimitForMaxMode: 1_000_000,
						variants: [
							{
								legacySlug: maxOnly.modelId,
								isMaxMode: true,
								isDefaultMaxConfig: true,
								parameterValues: [
									{ id: 'context', value: '1m' },
									{ id: 'effort', value: 'high' },
								],
							},
						],
					}),
				],
			}),
			create(GetUsableModelsResponseSchema, { models: [maxOnly] }),
			create(GetDefaultModelForCliResponseSchema, { model: maxOnly }),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: 'max-only-max',
			name: 'Max Only Max',
			wireModelId: 'max-only-wire',
			maxMode: true,
			parameters: [
				{ id: 'context', value: '1m' },
				{ id: 'effort', value: 'high' },
			],
			contextWindow: 1_000_000,
		});
	});

	test('omits unusable joins and fails when no complete metadata remains', () => {
		const unknown = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: 'unknown' })],
		});
		expect(() =>
			catalogModels(
				base,
				unknown,
				create(GetDefaultModelForCliResponseSchema, { model: unknown.models[0] }),
			),
		).toThrow('no fully described usable models');
	});

	test('uses Auto only before credentials or authenticated catalog state exist', async () => {
		const models = discovered();
		const state = new CursorCatalogState();
		expect(state.models(false)).toEqual([CURSOR_AUTO_MODEL]);
		expect(state.models(true)).toEqual([]);

		let persisted: readonly unknown[] | undefined;
		await state.refresh(
			async () => models,
			async (next) => {
				persisted = next;
			},
		);
		expect(persisted).toEqual(models);
		expect(state.models(true)).toEqual(models);
		expect(state.models(false)).toEqual(models);

		expect(
			state.refresh(
				async () => {
					throw new Error('refresh unavailable');
				},
				async () => undefined,
			),
		).rejects.toThrow('refresh unavailable');
		expect(state.models(true)).toEqual(models);

		expect(
			state.refresh(
				async () => [],
				async () => undefined,
			),
		).rejects.toThrow('authenticated catalog returned no models');
		expect(state.models(true)).toEqual(models);
	});

	test('writes and reads the versioned authenticated route cache atomically', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cursor-catalog-'));
		try {
			const models = discovered();
			await writeModelCache(directory, models, 1_000);
			expect(await readFreshModelCache(directory, 1_001)).toEqual(models);
			expect(await readFreshModelCache(directory, 601_000)).toBeUndefined();
			expect(await readLastKnownModelCache(directory)).toEqual(models);
			expect((await stat(join(directory, 'cursor-inference', 'models.json'))).mode & 0o777).toBe(
				0o600,
			);
			expect(
				await readFile(join(directory, 'cursor-inference', 'models.json'), 'utf8'),
			).not.toContain('accessToken');

			await writeFile(
				join(directory, 'cursor-inference', 'models.json'),
				'{"schemaVersion":1,"fetchedAt":1000,"models":[]}\n',
			);
			expect(await readLastKnownModelCache(directory)).toBeUndefined();

			await writeFile(
				join(directory, 'cursor-inference', 'models.json'),
				`${JSON.stringify({
					schemaVersion: 2,
					fetchedAt: 1_000,
					models: [{ ...models[0], parameters: undefined }],
				})}\n`,
			);
			expect(await readLastKnownModelCache(directory)).toBeUndefined();

			await writeFile(
				join(directory, 'cursor-inference', 'models.json'),
				`${JSON.stringify({
					schemaVersion: 2,
					fetchedAt: 1_000,
					models: [models[0], { ...models[0], name: 'Duplicate' }],
				})}\n`,
			);
			expect(await readLastKnownModelCache(directory)).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
