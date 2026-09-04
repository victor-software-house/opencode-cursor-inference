import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { $ } from 'bun';

const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-smoke-'));
const configHome = join(directory, 'config');
const cacheHome = join(directory, 'cache');
const dataHome = join(directory, 'data');
const home = join(directory, 'home');
const workspace = join(directory, 'workspace');
const proof = join(workspace, 'proof.txt');
const log = join(directory, 'provider.jsonl');

try {
	await Promise.all([
		mkdir(join(configHome, 'opencode'), { recursive: true }),
		mkdir(join(cacheHome, 'opencode', 'cursor-inference'), { recursive: true }),
		mkdir(dataHome, { recursive: true }),
		mkdir(home, { recursive: true }),
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
	const models = await $`bunx --bun opencode-ai@1.18.27 models cursor`
		.env(environment)
		.cwd(workspace)
		.quiet()
		.text();
	if (!models.split('\n').includes('cursor/fixture-model')) {
		throw new Error('Built Cursor plugin did not register its cached fixture model');
	}
	const run =
		await $`bunx --bun opencode-ai@1.18.27 run --dir ${workspace} --model smoke/fixture ${'Use the read tool once.'}`
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
	console.log(
		'OpenCode 1.18.27 loaded the built Cursor plugin and completed host tool continuation.',
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
