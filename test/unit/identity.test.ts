import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IdentityDependencies } from '@cursor/identity';
import {
	deriveHostMachineId,
	deriveMacMachineId,
	firstUsableMac,
	loadCursorMachineIdentity,
	machineIdCommand,
	normalizeHardwareId,
} from '@cursor/identity';

const fallbackUuid = '123e4567-e89b-42d3-a456-426614174000';

function dependencies(overrides: Partial<IdentityDependencies> = {}): IdentityDependencies {
	return {
		platform: 'linux',
		arch: 'x64',
		env: {},
		execute: () => '0123456789abcdef\n',
		interfaces: () => ({ ethernet: [{ mac: 'AA-BB-CC-DD-EE-FF' }] }),
		createUuid: () => fallbackUuid,
		...overrides,
	};
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'cursor-inference-identity-'));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('Cursor machine identity', () => {
	test('uses Cursor 3.18.9 platform commands', () => {
		expect(machineIdCommand('darwin', 'arm64', {})).toBe('ioreg -rd1 -c IOPlatformExpertDevice');
		expect(machineIdCommand('linux', 'x64', {})).toBe(
			'( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :',
		);
		expect(machineIdCommand('freebsd', 'x64', {})).toBe(
			'kenv -q smbios.system.uuid || sysctl -n kern.hostuuid',
		);
		expect(machineIdCommand('win32', 'x64', {})).toBe(
			'%windir%\\System32\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
		);
		expect(machineIdCommand('win32', 'ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' })).toBe(
			'%windir%\\sysnative\\cmd.exe /c %windir%\\System32\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
		);
	});

	test('normalizes each supported platform exactly', () => {
		expect(
			normalizeHardwareId(
				'darwin',
				'    "IOPlatformUUID" = "ABC-123"\n    "IOPlatformSerialNumber" = "ignored"',
			),
		).toBe('abc-123');
		expect(normalizeHardwareId('win32', 'MachineGuid    REG_SZ    MACHINE-GUID\r\n')).toBe(
			'machine-guid',
		);
		expect(normalizeHardwareId('linux', '  ABC DEF\n')).toBe('abcdef');
		expect(normalizeHardwareId('freebsd', '\r\nABC-DEF\n')).toBe('abc-def');
	});

	test('hashes the normalized hardware id', () => {
		expect(deriveHostMachineId(dependencies())).toBe(
			'9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc7365c9c28b548e564176929f',
		);
	});

	test('selects the first acceptable MAC and hashes its original spelling', () => {
		const interfaces = {
			loopback: [{ mac: '00:00:00:00:00:00' }],
			virtual: [{ mac: 'AC-DE-48-00-11-22' }],
			ethernet: [{ mac: 'AA-BB-CC-DD-EE-FF' }],
		};
		expect(firstUsableMac(interfaces)).toBe('AA-BB-CC-DD-EE-FF');
		expect(deriveMacMachineId({ interfaces: () => interfaces })).toBe(
			'4ede89a251930543e704b69f048db754f41e528296cf963d8ba66238781e429b',
		);
	});

	test('omits the MAC identity when no acceptable address exists', () => {
		expect(
			deriveMacMachineId({ interfaces: () => ({ loopback: [{ mac: '00:00:00:00:00:00' }] }) }),
		).toBeUndefined();
	});

	test('persists and reuses the random UUID only when host derivation fails', async () => {
		await withTempDir(async (directory) => {
			const first = await loadCursorMachineIdentity(
				directory,
				dependencies({ platform: 'aix', interfaces: () => ({}) }),
			);
			expect(first).toEqual({ machineId: fallbackUuid, machineIdSource: 'fallback' });

			const second = await loadCursorMachineIdentity(
				directory,
				dependencies({
					platform: 'aix',
					interfaces: () => ({}),
					createUuid: () => {
						throw new Error('must not generate another identity');
					},
				}),
			);
			expect(second).toEqual(first);
			expect(await readFile(join(directory, 'cursor-inference', 'identity.json'), 'utf8')).toBe(
				`${JSON.stringify({ machineId: fallbackUuid })}\n`,
			);
		});
	});

	test('rejects a corrupt persisted fallback instead of silently replacing it', async () => {
		await withTempDir(async (directory) => {
			await mkdir(join(directory, 'cursor-inference'));
			await writeFile(
				join(directory, 'cursor-inference', 'identity.json'),
				'{"machineId":"bad"}\n',
			);
			try {
				await loadCursorMachineIdentity(directory, dependencies({ platform: 'aix' }));
				throw new Error('expected corrupt fallback identity to fail');
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				expect(error.message).toBe('Persisted Cursor fallback identity is invalid');
			}
		});
	});
});
