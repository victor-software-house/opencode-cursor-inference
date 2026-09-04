import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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

async function availablePort(): Promise<number> {
	const reservation = createServer();
	await new Promise<void>((done, reject) => {
		reservation.once('error', reject);
		reservation.listen(0, '127.0.0.1', done);
	});
	const address = reservation.address();
	if (address === null || typeof address === 'string')
		throw new Error('Could not reserve a TCP port');
	await new Promise<void>((done, reject) =>
		reservation.close((error) => (error ? reject(error) : done())),
	);
	return address.port;
}

async function waitForServer(url: string, server: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (server.exitCode !== null)
			throw new Error(`OpenCode V2 server exited with ${String(server.exitCode)}`);
		try {
			await fetch(`${url}/api/health`);
			return;
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error('OpenCode V2 server did not become ready');
}

const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'opencode-cursor-smoke-'));
const configHome = join(directory, 'config');
const cacheHome = join(directory, 'cache');
const dataHome = join(directory, 'data');
const home = join(directory, 'home');
const stableAutoConfigHome = join(directory, 'config-v1-auto');
const stableAutoCacheHome = join(directory, 'cache-v1-auto');
const stableAutoDataHome = join(directory, 'data-v1-auto');
const stableAutoHome = join(directory, 'home-v1-auto');
const v2ConfigHome = join(directory, 'config-v2');
const v2CacheHome = join(directory, 'cache-v2');
const v2DataHome = join(directory, 'data-v2');
const v2Home = join(directory, 'home-v2');
const v2Plugin = join(directory, 'plugin-v2');
const v2Fixture = join(directory, 'fixture-v2');
const workspace = join(directory, 'workspace');
const proof = join(workspace, 'proof.txt');
const log = join(directory, 'provider.jsonl');
const v2Log = join(directory, 'provider-v2.jsonl');
const fixtureAccess = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.signature`;

try {
	await Promise.all([
		mkdir(join(configHome, 'opencode'), { recursive: true }),
		mkdir(join(cacheHome, 'opencode', 'cursor-inference'), { recursive: true }),
		mkdir(join(dataHome, 'opencode'), { recursive: true }),
		mkdir(home, { recursive: true }),
		mkdir(join(stableAutoConfigHome, 'opencode'), { recursive: true }),
		mkdir(stableAutoCacheHome, { recursive: true }),
		mkdir(stableAutoDataHome, { recursive: true }),
		mkdir(stableAutoHome, { recursive: true }),
		mkdir(join(v2ConfigHome, 'opencode'), { recursive: true }),
		mkdir(join(v2CacheHome, 'opencode', 'cursor-inference'), { recursive: true }),
		mkdir(v2DataHome, { recursive: true }),
		mkdir(v2Home, { recursive: true }),
		mkdir(v2Plugin, { recursive: true }),
		mkdir(v2Fixture, { recursive: true }),
		mkdir(workspace, { recursive: true }),
	]);
	await writeFile(proof, 'verified\n');
	await writeFile(
		join(dataHome, 'opencode', 'auth.json'),
		`${JSON.stringify({
			cursor: {
				type: 'oauth',
				access: fixtureAccess,
				refresh: 'fixture-refresh',
				expires: 2_000_000_000_000,
			},
		})}\n`,
		{ mode: 0o600 },
	);
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
		join(stableAutoConfigHome, 'opencode', 'opencode.json'),
		`${JSON.stringify({ plugin: [cursorPlugin] })}\n`,
	);
	const stableAutoEnvironment = {
		...process.env,
		HOME: stableAutoHome,
		XDG_CONFIG_HOME: stableAutoConfigHome,
		XDG_CACHE_HOME: stableAutoCacheHome,
		XDG_DATA_HOME: stableAutoDataHome,
	};
	const stableAutoModels = (
		await $`bunx --bun opencode-ai@1.18.28 models cursor`
			.env(stableAutoEnvironment)
			.cwd(workspace)
			.quiet()
			.text()
	)
		.split('\n')
		.filter((line) => line !== '');
	if (stableAutoModels.length !== 1 || stableAutoModels[0] !== 'cursor/default') {
		throw new Error(
			`Stable OpenCode did not expose exactly Cursor default/Auto: ${stableAutoModels.join(', ')}`,
		);
	}
	if (
		await Bun.file(
			join(stableAutoCacheHome, 'opencode', 'cursor-inference', 'models.json'),
		).exists()
	) {
		throw new Error('Stable OpenCode persisted the authless Auto fallback');
	}
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
	await Promise.all([
		cp(join(root, 'test', 'fixtures', 'opencode-v2-plugin.mjs'), join(v2Fixture, 'server.mjs')),
		cp(
			join(root, 'test', 'fixtures', 'opencode-provider.mjs'),
			join(v2Fixture, 'opencode-provider.mjs'),
		),
		symlink(join(root, 'node_modules'), join(v2Fixture, 'node_modules'), 'dir'),
	]);
	await writeFile(
		join(v2Fixture, 'package.json'),
		`${JSON.stringify({
			name: 'opencode-cursor-v2-fixture',
			version: '0.0.0',
			type: 'module',
			exports: { '.': './server.mjs', './server': './server.mjs' },
		})}\n`,
	);
	await writeFile(
		join(v2ConfigHome, 'opencode', 'opencode.json'),
		`${JSON.stringify({ plugins: [v2Plugin, v2Fixture] })}\n`,
	);
	const v2Environment = {
		...process.env,
		HOME: v2Home,
		XDG_CONFIG_HOME: v2ConfigHome,
		XDG_CACHE_HOME: v2CacheHome,
		XDG_DATA_HOME: v2DataHome,
		OPENCODE_CURSOR_SMOKE_LOG: v2Log,
		OPENCODE_CURSOR_SMOKE_FILE: proof,
		OPENCODE_SERVER_PASSWORD: 'smoke-password',
	};
	const v2ServerUrl = `http://127.0.0.1:${String(await availablePort())}`;
	const v2Server = Bun.spawn({
		cmd: ['opencode2', 'serve', '--hostname', '127.0.0.1', '--port', new URL(v2ServerUrl).port],
		cwd: workspace,
		env: v2Environment,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	try {
		await waitForServer(v2ServerUrl, v2Server);
		const v2 = parseJson(
			await $`opencode2 api --server ${v2ServerUrl} v2.plugin.check --data ${'{}'}`
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
				`OpenCode V2 did not activate the built hybrid Cursor plugin: ${JSON.stringify(v2)}`,
			);
		}

		const v2ModelResponse = parseJson(
			await $`opencode2 api --server ${v2ServerUrl} v2.model.list`
				.env(v2Environment)
				.cwd(workspace)
				.quiet()
				.text(),
		);
		const v2ProviderResponse = parseJson(
			await $`opencode2 api --server ${v2ServerUrl} v2.provider.list`
				.env(v2Environment)
				.cwd(workspace)
				.quiet()
				.text(),
		);
		const v2Providers = isRecord(v2ProviderResponse)
			? unknownArray(v2ProviderResponse['data'])
			: [];
		const cursorProvider = v2Providers.find(
			(provider) => isRecord(provider) && provider['id'] === 'cursor',
		);
		if (!isRecord(cursorProvider)) {
			throw new Error(
				`OpenCode V2 did not expose the Cursor provider: ${JSON.stringify(v2ProviderResponse)}`,
			);
		}
		const v2Models = isRecord(v2ModelResponse) ? unknownArray(v2ModelResponse['data']) : [];
		const cursorModels = v2Models.filter(
			(model) => isRecord(model) && model['providerID'] === 'cursor',
		);
		if (
			cursorModels.length !== 1 ||
			!isRecord(cursorModels[0]) ||
			cursorModels[0]['modelID'] !== 'default' ||
			cursorModels[0]['name'] !== 'Auto'
		) {
			throw new Error(
				`OpenCode V2 did not expose exactly Cursor default/Auto: ${JSON.stringify({ model: v2ModelResponse, provider: cursorProvider })}`,
			);
		}
		if (await Bun.file(join(v2CacheHome, 'opencode', 'cursor-inference', 'models.json')).exists()) {
			throw new Error('OpenCode V2 persisted the authless Auto fallback');
		}
	} finally {
		v2Server.kill();
		await v2Server.exited;
	}

	const v2Read =
		await $`opencode2 run --standalone --auto --model smoke/v2-fixture ${'Use the read tool once.'}`
			.env(v2Environment)
			.cwd(workspace)
			.quiet()
			.text();
	if (!v2Read.includes('OPENCODE_CURSOR_SMOKE_OK')) {
		throw new Error('OpenCode V2 did not continue after its host-executed synthetic tool call');
	}
	const v2Unknown =
		await $`opencode2 run --standalone --auto --model smoke/unknown ${'Call the available tool.'}`
			.env(v2Environment)
			.cwd(workspace)
			.quiet()
			.text();
	if (!v2Unknown.includes('OPENCODE_CURSOR_UNKNOWN_TOOL_OK')) {
		throw new Error('OpenCode V2 did not continue after its unavailable-tool result');
	}
	const v2Calls = await readFile(v2Log, 'utf8');
	if (
		!v2Calls.includes('"modelId":"unknown"') ||
		!v2Calls.includes('"toolName":"unavailable_tool"') ||
		!v2Calls.includes('"type":"tool-result"') ||
		!v2Calls.includes('Unknown tool: unavailable_tool') ||
		!v2Calls.includes('verified')
	) {
		throw new Error('OpenCode V2 did not return its unavailable-tool result to the provider');
	}
	console.log(
		'OpenCode V2 beta 19086 and stable V1 1.18.28 loaded the hybrid Cursor plugin; both exposed authless Auto, both completed host tool continuation, and V2 returned unavailable-tool errors to the model.',
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
