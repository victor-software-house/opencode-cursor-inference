#!/usr/bin/env bun
//MISE description="Block local package.json version drift from origin/main"

import { env, exit, stderr } from 'node:process';

if (env['CI'] === 'true') exit(0);

const branch = Bun.spawnSync({
	cmd: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
	stdout: 'pipe',
})
	.stdout.toString()
	.trim();
if (branch.startsWith('changeset-release/')) exit(0);

Bun.spawnSync({
	cmd: ['git', 'fetch', 'origin', 'main', '--quiet'],
	stderr: 'ignore',
});

const files = Bun.spawnSync({
	cmd: ['git', 'ls-files', 'package.json', '*/package.json'],
	stdout: 'pipe',
})
	.stdout.toString()
	.split('\n')
	.filter((line) => line !== '');

let errors = 0;
for (const file of files) {
	const remote = Bun.spawnSync({
		cmd: ['git', 'show', `origin/main:${file}`],
		stdout: 'pipe',
		stderr: 'ignore',
	});
	if (remote.exitCode !== 0) continue;

	const remoteVersion = packageVersion(remote.stdout.toString());
	const localVersion = packageVersion(await Bun.file(file).text());
	if (remoteVersion !== undefined && remoteVersion !== localVersion) {
		stderr.write(`BLOCKED: ${file} version changed locally (${remoteVersion} → ${localVersion})\n`);
		stderr.write('  Versions are CI-managed through Changesets.\n');
		errors += 1;
	}
}

if (errors > 0) exit(1);

function packageVersion(text: string): string | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (
			typeof value === 'object' &&
			value !== null &&
			'version' in value &&
			typeof value.version === 'string'
		) {
			return value.version;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
