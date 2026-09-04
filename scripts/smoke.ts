import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '@victor-software-house/pi-type-kit';
import { $ } from 'bun';

function parseJson(text: string): unknown {
	const value: unknown = JSON.parse(text);
	return value;
}

function unknownArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-smoke-'));
const configHome = join(directory, 'config');
const cacheHome = join(directory, 'cache');
const dataHome = join(directory, 'data');
const home = join(directory, 'home');
const v2ConfigHome = join(directory, 'config-v2');
const v2CacheHome = join(directory, 'cache-v2');
const v2DataHome = join(directory, 'data-v2');
const v2Home = join(directory, 'home-v2');
const v2Plugin = join(directory, 'plugin-v2');
const workspace = join(directory, 'workspace');
const proof = join(workspace, 'proof.txt');
const log = join(directory, 'provider.jsonl');

try {
	await Promise.all([
		mkdir(join(configHome, 'opencode'), { recursive: true }),
		mkdir(join(cacheHome, 'opencode', 'cursor-inference'), { recursive: true }),
		mkdir(dataHome, { recursive: true }),
		mkdir(home, { recursive: true }),
		mkdir(join(v2ConfigHome, 'opencode'), { recursive: true }),
		mkdir(join(v2CacheHome, 'opencode', 'cursor-inference'), { recursive: true }),
		mkdir(v2DataHome, { recursive: true }),
		mkdir(v2Home, { recursive: true }),
		mkdir(v2Plugin, { recursive: true }),
		mkdir(workspace, { recursive: true }),
	]);
	await writeFile(proof, 'verified\n');
	await $`git init -q ${workspace}`.quiet();
	await writeFile(
		join(cacheHome, 'opencode', 'cursor-inference', 'models.json'),
		`${JSON.stringify({
			schemaVersion: 1,
			fetchedAt: 4_102_444_800_000,
			models: [
				{
					id: 'fixture-model',
					name: 'Cursor Fixture',
					wireModelId: 'fixture-model',
					maxMode: false,
					contextWindow: 200_000,
					reasoning: false,
					images: false,
				},
			],
		})}\n`,
	);
	await cp(
		join(cacheHome, 'opencode', 'cursor-inference', 'models.json'),
		join(v2CacheHome, 'opencode', 'cursor-inference', 'models.json'),
	);
	const cursorPlugin = pathToFileURL(join(root, 'dist', 'plugin.mjs')).href;
	const smokePlugin = pathToFileURL(join(root, 'test', 'fixtures', 'opencode-plugin.mjs')).href;
	const smokeProvider = pathToFileURL(join(root, 'test', 'fixtures', 'opencode-provider.mjs')).href;
	await writeFile(
		join(configHome, 'opencode', 'opencode.json'),
		`${JSON.stringify({
			$schema: 'https://opencode.ai/config.json',
			plugin: [cursorPlugin, smokePlugin],
			provider: {
				smoke: {
					name: 'Smoke',
					npm: smokeProvider,
					models: {
						fixture: {
							name: 'Fixture',
							tool_call: true,
							limit: { context: 100_000, output: 1_000 },
						},
					},
				},
			},
			permission: { read: 'allow', external_directory: 'allow' },
		})}\n`,
	);
	const environment = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: configHome,
		XDG_CACHE_HOME: cacheHome,
		XDG_DATA_HOME: dataHome,
		OPENCODE_CURSOR_SMOKE_LOG: log,
		OPENCODE_CURSOR_SMOKE_FILE: proof,
	};
	const models = await $`bunx --bun opencode-ai@1.18.28 models cursor`
		.env(environment)
		.cwd(workspace)
		.quiet()
		.text();
	if (!models.split('\n').includes('cursor/fixture-model')) {
		throw new Error('Built Cursor plugin did not register its cached fixture model');
	}
	const run =
		await $`bunx --bun opencode-ai@1.18.28 run --dir ${workspace} --model smoke/fixture ${'Use the read tool once.'}`
			.env(environment)
			.cwd(workspace)
			.quiet()
			.text();
	if (!run.includes('OPENCODE_CURSOR_SMOKE_OK')) {
		throw new Error('OpenCode did not continue after its host-executed synthetic tool call');
	}
	const calls = await readFile(log, 'utf8');
	if (!calls.includes('"role":"tool"') || !calls.includes('"type":"tool-result"')) {
		throw new Error('OpenCode did not return a host-owned tool result to the provider');
	}

	const builtRuntime = await Promise.all(
		['plugin.mjs', 'index.mjs', 'lifecycle.mjs'].map(
			async (file) => await readFile(join(root, 'dist', file), 'utf8'),
		),
	);
	for (const packageName of [
		'@victor-software-house/pi-type-kit',
		'@opencode-ai/plugin-v2',
		'@opencode-ai/schema-v2',
	]) {
		if (builtRuntime.some((source) => source.includes(packageName))) {
			throw new Error(`Bundled build dependency escaped into the runtime: ${packageName}`);
		}
	}

	await Promise.all(
		['plugin.mjs', 'index.mjs', 'lifecycle.mjs'].map(
			async (file) => await cp(join(root, 'dist', file), join(v2Plugin, file)),
		),
	);
	await cp(join(v2Plugin, 'plugin.mjs'), join(v2Plugin, 'server.mjs'));
	await writeFile(
		join(v2Plugin, 'package.json'),
		`${JSON.stringify({
			name: 'opencode-cursor-inference-smoke',
			version: '0.0.0',
			type: 'module',
			exports: { '.': './plugin.mjs', './server': './plugin.mjs' },
		})}\n`,
	);
	await symlink(join(root, 'node_modules'), join(v2Plugin, 'node_modules'), 'dir');
	await writeFile(
		join(v2ConfigHome, 'opencode', 'opencode.json'),
		`${JSON.stringify({ plugins: [v2Plugin] })}\n`,
	);
	const v2Environment = {
		...process.env,
		HOME: v2Home,
		XDG_CONFIG_HOME: v2ConfigHome,
		XDG_CACHE_HOME: v2CacheHome,
		XDG_DATA_HOME: v2DataHome,
	};
	const v2 = parseJson(
		await $`opencode2 api --standalone v2.plugin.check --data ${'{}'}`
			.env(v2Environment)
			.cwd(workspace)
			.quiet()
			.text(),
	);
	const plugins = isRecord(v2) ? unknownArray(v2['data']) : [];
	const cursorV2 = plugins.find(
		(plugin) => isRecord(plugin) && plugin['id'] === 'opencode-cursor-inference',
	);
	if (
		!isRecord(cursorV2) ||
		!isRecord(cursorV2['state']) ||
		cursorV2['state']['status'] !== 'active'
	) {
		throw new Error(
			`OpenCode V2 did not activate the built hybrid Cursor plugin: ${JSON.stringify(cursorV2 ?? v2)}`,
		);
	}
	console.log(
		'OpenCode V2 beta 19086 and stable V1 1.18.28 loaded the hybrid Cursor plugin; V1 completed host tool continuation.',
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
