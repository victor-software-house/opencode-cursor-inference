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

const usableModel = create(ModelDetailsSchema, {
	modelId: 'claude-sonnet-medium',
	displayName: 'Claude Sonnet Medium',
});
const base = create(AvailableModelsResponseSchema, {
	models: [
		create(AvailableModelsResponse_AvailableModelSchema, {
			name: 'claude-sonnet',
			clientDisplayName: 'Claude Sonnet',
			legacySlugs: ['claude-sonnet-medium'],
			supportsThinking: true,
			supportsImages: true,
			supportsMaxMode: true,
			supportsNonMaxMode: true,
			contextTokenLimit: 200_000,
			contextTokenLimitForMaxMode: 1_000_000,
			variants: [
				{
					parameterValues: [{ id: 'context', value: '200k' }],
					displayName: 'Claude Sonnet',
					isDefaultNonMaxConfig: true,
				},
				{
					parameterValues: [{ id: 'context', value: '1m' }],
					displayName: 'Claude Sonnet Max',
					isMaxMode: true,
					isDefaultMaxConfig: true,
				},
			],
		}),
	],
});
const usable = create(GetUsableModelsResponseSchema, { models: [usableModel] });
const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usableModel });

describe('Cursor catalog', () => {
	test('joins all three catalog responses and emits only measured model rows', () => {
		const models = catalogModels(base, usable, defaultModel);
		expect(models).toEqual([
			{
				id: 'claude-sonnet',
				name: 'Claude Sonnet',
				wireModelId: 'claude-sonnet-medium',
				maxMode: false,
				context: '200k',
				contextWindow: 200_000,
				reasoning: true,
				images: true,
			},
			{
				id: 'claude-sonnet-max',
				name: 'Claude Sonnet Max',
				wireModelId: 'claude-sonnet-medium',
				maxMode: true,
				context: '1m',
				contextWindow: 1_000_000,
				reasoning: true,
				images: true,
			},
		]);
		expect(modelsToConfig(models)['claude-sonnet-max']).toMatchObject({
			reasoning: true,
			attachment: true,
			modalities: { input: ['text', 'image'], output: ['text'] },
			limit: { context: 1_000_000, output: 64_000 },
			options: {
				cursorWireModelId: 'claude-sonnet-medium',
				cursorMaxMode: true,
				cursorContext: '1m',
			},
		});
	});

	test('omits unknown usable models and fails when no complete metadata remains', () => {
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

	test('collapses effort selections into one model family with a preferred wire model', () => {
		const efforts = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: 'claude-sonnet-high',
					displayName: 'Claude Sonnet High',
				}),
				usableModel,
			],
		});
		const models = catalogModels(
			base,
			efforts,
			create(GetDefaultModelForCliResponseSchema, { model: usableModel }),
		);
		expect(models).toHaveLength(2);
		expect(models.map(({ id }) => id)).toEqual(['claude-sonnet', 'claude-sonnet-max']);
		expect(models.map(({ wireModelId }) => wireModelId)).toEqual([
			'claude-sonnet-medium',
			'claude-sonnet-medium',
		]);
	});

	test('uses Auto only before credentials or authenticated catalog state exist', async () => {
		const models = catalogModels(base, usable, defaultModel);
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
				async () => [{ ...CURSOR_AUTO_MODEL, id: 'new-model', name: 'New Model' }],
				async () => {
					throw new Error('cache unavailable');
				},
			),
		).rejects.toThrow('cache unavailable');
		expect(state.models(true)).toEqual(models);

		let emptyPersisted = false;
		expect(
			state.refresh(
				async () => [],
				async () => {
					emptyPersisted = true;
				},
			),
		).rejects.toThrow('authenticated catalog returned no models');
		expect(emptyPersisted).toBe(false);
		expect(state.models(true)).toEqual(models);
	});

	test('writes and reads authenticated cache atomically, including stale state', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cursor-catalog-'));
		try {
			const models = catalogModels(base, usable, defaultModel);
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
			expect(await readFreshModelCache(directory, 1_001)).toBeUndefined();
			expect(await readLastKnownModelCache(directory)).toBeUndefined();

			await writeFile(
				join(directory, 'cursor-inference', 'models.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					fetchedAt: 1_000,
					models: [models[0], { ...models[0], name: 'Duplicate' }],
				})}\n`,
			);
			expect(await readLastKnownModelCache(directory)).toBeUndefined();

			await writeFile(
				join(directory, 'cursor-inference', 'models.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					fetchedAt: 1_000,
					models: [{ ...models[0], wireModelId: '' }],
				})}\n`,
			);
			expect(await readLastKnownModelCache(directory)).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
