import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exit, stderr } from 'node:process';
import { gzipSync } from 'node:zlib';
import pkg from '@repo/package.json' with { type: 'json' };
import { runtimePackageNames } from '@victor-software-house/pi-type-kit';
import { $ } from 'bun';

const allowedFiles = new Set([
	'package/package.json',
	'package/README.md',
	'package/CHANGELOG.md',
	'package/LICENSE',
	'package/docs/banner.svg',
	'package/docs/banner-dark.svg',
	'package/docs/decisions.md',
	'package/docs/research.md',
	'package/dist/index.mjs',
	'package/dist/index.d.mts',
	'package/dist/lifecycle.mjs',
	'package/dist/plugin.mjs',
	'package/dist/plugin.d.mts',
]);
const runtimeBudgets = new Map([
	['index.mjs', { raw: 60_000, gzip: 22_000 }],
	['lifecycle.mjs', { raw: 1_000, gzip: 500 }],
	['plugin.mjs', { raw: 110_000, gzip: 38_000 }],
]);
const declarationBudgets = new Map([
	['index.d.mts', 2_000],
	['plugin.d.mts', 2_000],
]);
const forbiddenArtifact: readonly RegExp[] = [
	/sourceMappingURL/u,
	/@victor-software-house\//u,
	/victor-software-house\/pi-stuff/u,
	/@opencode-ai\/(?:plugin-v2|schema-v2)/u,
	/PI_CURSOR_PACKAGES_TOKEN/u,
	/\/Users\/[a-z]/u,
	/\/home\/[a-z]/u,
	/[A-Za-z]:\\Users\\/u,
];
const forbiddenRuntime: readonly RegExp[] = [...forbiddenArtifact, /\bsrc\/[a-z0-9_./-]+\.ts\b/iu];
const allowedImports = new Set(runtimePackageNames(pkg));
const allowedRelativeImports = new Set(['./lifecycle.mjs']);
const workDir = mkdtempSync(join(tmpdir(), 'opencode-cursor-pack-'));
const consumerDir = join(workDir, 'consumer');
const failures: string[] = [];

function isAllowedPackageImport(specifier: string): boolean {
	return [...allowedImports].some(
		(packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
	);
}

async function checkConsumer(runtime: 'node' | 'bun'): Promise<void> {
	const probe = [
		"const root = await import('opencode-cursor-inference');",
		"const plugin = await import('opencode-cursor-inference/plugin');",
		"const server = await import('opencode-cursor-inference/server');",
		"const provider = await import('opencode-cursor-inference/provider');",
		"if (root.default !== plugin.default || root.default !== server.default) throw new Error('hybrid exports diverged');",
		"if (typeof root.default?.setup !== 'function' || typeof root.default?.server !== 'function') throw new Error('hybrid entry is incomplete');",
		"if (typeof provider.createCursor !== 'function') throw new Error('provider export is missing');",
	].join(' ');
	const process = Bun.spawn({
		cmd: [runtime, '--eval', probe],
		cwd: consumerDir,
		stdout: 'ignore',
		stderr: 'pipe',
		timeout: 8_000,
		killSignal: 'SIGKILL',
	});
	const [exitCode, errorOutput] = await Promise.all([
		process.exited,
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) {
		failures.push(
			`${runtime} rejected the packed public exports (exit ${String(exitCode)}${process.killed ? ', timed out' : ''}): ${errorOutput.trim()}`,
		);
	}
}

try {
	await $`bun pm pack --destination ${workDir} --quiet`.quiet();
	const tarballs = [...new Bun.Glob('*.tgz').scanSync(workDir)];
	const tarball = tarballs[0];
	if (tarball === undefined || tarballs.length !== 1) {
		failures.push(`expected exactly one tarball, found ${String(tarballs.length)}`);
	} else {
		const tarballPath = join(workDir, tarball);
		const entries = (await $`tar tzf ${tarballPath}`.text())
			.split('\n')
			.filter((entry) => entry !== '' && !entry.endsWith('/'));
		for (const entry of entries) {
			if (!allowedFiles.has(entry)) failures.push(`file outside package whitelist: ${entry}`);
		}
		for (const expected of allowedFiles) {
			if (!entries.includes(expected))
				failures.push(`required package file is missing: ${expected}`);
		}

		await $`tar xzf ${tarballPath} -C ${workDir}`.quiet();
		const distDir = join(workDir, 'package', 'dist');
		for (const [file, budget] of runtimeBudgets) {
			const source = await Bun.file(join(distDir, file)).text();
			const rawBytes = Buffer.byteLength(source);
			const gzipBytes = gzipSync(source).byteLength;
			if (rawBytes > budget.raw) {
				failures.push(
					`${file} exceeds its ${String(budget.raw)} byte budget (${String(rawBytes)})`,
				);
			}
			if (gzipBytes > budget.gzip) {
				failures.push(
					`${file} exceeds its ${String(budget.gzip)} gzip budget (${String(gzipBytes)})`,
				);
			}
			if (source.split('\n').length > 50) failures.push(`${file} is not minified`);
			for (const pattern of forbiddenRuntime) {
				if (pattern.test(source))
					failures.push(`${file} matches forbidden runtime pattern ${pattern}`);
			}
			const imports = [...source.matchAll(/(?:from|import\()(["'])([^"']+)\1/gu)].flatMap(
				(match) => (match[2] === undefined ? [] : [match[2]]),
			);
			for (const specifier of new Set(imports)) {
				if (specifier.startsWith('node:')) continue;
				if (specifier.startsWith('.')) {
					if (!allowedRelativeImports.has(specifier)) {
						failures.push(`${file} has unexpected relative import: ${specifier}`);
					}
					continue;
				}
				if (!isAllowedPackageImport(specifier)) {
					failures.push(`${file} has unexpected external import: ${specifier}`);
				}
			}
		}
		for (const [file, budget] of declarationBudgets) {
			const declaration = await Bun.file(join(distDir, file)).text();
			const bytes = Buffer.byteLength(declaration);
			if (bytes > budget) {
				failures.push(`${file} exceeds its ${String(budget)} byte budget (${String(bytes)})`);
			}
			for (const pattern of forbiddenArtifact) {
				if (pattern.test(declaration)) {
					failures.push(`${file} matches forbidden declaration pattern ${pattern}`);
				}
			}
		}

		await $`mkdir -p ${consumerDir}`.quiet();
		await Bun.write(
			join(consumerDir, 'package.json'),
			`${JSON.stringify({ name: 'packed-consumer', private: true, type: 'module' })}\n`,
		);
		await $`bun add ${tarballPath}`.cwd(consumerDir).quiet();
		await Promise.all([checkConsumer('node'), checkConsumer('bun')]);
	}
} finally {
	rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	for (const failure of failures) stderr.write(`pack:verify ✘ ${failure}\n`);
	exit(1);
}

console.log('pack:verify ✔ exact files, bounded artifacts, clean imports, and Node/Bun exports');
