import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { arch, env, platform } from 'node:process';
import { isRecord } from '@cursor/guards';

export const CURSOR_IDE_VERSION = '3.18.9';
export const CURSOR_IDE_COMMIT = '2ba48ff3f7514cc4643c52ca9f7b3173d9b66130';

const rejectedMacAddresses = new Set([
	'00:00:00:00:00:00',
	'ff:ff:ff:ff:ff:ff',
	'ac:de:48:00:11:22',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CursorMachineIdentity {
	readonly machineId: string;
	readonly macMachineId?: string;
	readonly machineIdSource: 'host' | 'fallback';
}

export interface NetworkInterfaceMap {
	readonly [name: string]: readonly { readonly mac: string }[] | undefined;
}

export interface IdentityDependencies {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly env: NodeJS.ProcessEnv;
	readonly execute: (command: string) => string;
	readonly interfaces: () => NetworkInterfaceMap;
	readonly createUuid: () => string;
}

const defaultDependencies: IdentityDependencies = {
	platform,
	arch,
	env,
	execute: (command) => execSync(command, { timeout: 5_000 }).toString(),
	interfaces: networkInterfaces,
	createUuid: randomUUID,
};

export function machineIdCommand(
	targetPlatform: NodeJS.Platform,
	targetArch: string,
	targetEnv: NodeJS.ProcessEnv,
): string {
	switch (targetPlatform) {
		case 'darwin':
			return 'ioreg -rd1 -c IOPlatformExpertDevice';
		case 'win32': {
			const windowsRoot =
				targetArch === 'ia32' && Object.hasOwn(targetEnv, 'PROCESSOR_ARCHITEW6432')
					? '%windir%\\sysnative\\cmd.exe /c %windir%\\System32'
					: '%windir%\\System32';
			return `${windowsRoot}\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid`;
		}
		case 'linux':
			return '( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :';
		case 'freebsd':
			return 'kenv -q smbios.system.uuid || sysctl -n kern.hostuuid';
		default:
			throw new Error(`Unsupported platform: ${targetPlatform}`);
	}
}

/** Normalize the platform command output exactly as Cursor 3.18.9 `H9e`. */
export function normalizeHardwareId(targetPlatform: NodeJS.Platform, output: string): string {
	switch (targetPlatform) {
		case 'darwin': {
			const value = output.split('IOPlatformUUID')[1]?.split('\n')[0];
			if (value === undefined) throw new Error('IOPlatformUUID is missing');
			return value.replace(/=|\s+|"/giu, '').toLowerCase();
		}
		case 'win32': {
			const value = output.split('REG_SZ')[1];
			if (value === undefined) throw new Error('MachineGuid is missing');
			return value.replace(/\r+|\n+|\s+/giu, '').toLowerCase();
		}
		case 'linux':
		case 'freebsd':
			return output.replace(/\r+|\n+|\s+/giu, '').toLowerCase();
		default:
			throw new Error(`Unsupported platform: ${targetPlatform}`);
	}
}

export function deriveHostMachineId(
	dependencies: IdentityDependencies = defaultDependencies,
): string {
	const command = machineIdCommand(dependencies.platform, dependencies.arch, dependencies.env);
	const hardwareId = normalizeHardwareId(dependencies.platform, dependencies.execute(command));
	return createHash('sha256').update(hardwareId, 'utf8').digest('hex');
}

export function firstUsableMac(interfaces: NetworkInterfaceMap): string {
	for (const name in interfaces) {
		const entries = interfaces[name];
		if (entries === undefined) continue;
		for (const entry of entries) {
			const normalized = entry.mac.replace(/-/gu, ':').toLowerCase();
			if (!rejectedMacAddresses.has(normalized)) return entry.mac;
		}
	}
	throw new Error('Unable to retrieve mac address (unexpected format)');
}

export function deriveMacMachineId(
	dependencies: Pick<IdentityDependencies, 'interfaces'> = defaultDependencies,
): string | undefined {
	try {
		return createHash('sha256')
			.update(firstUsableMac(dependencies.interfaces()), 'utf8')
			.digest('hex');
	} catch {
		return undefined;
	}
}

function fallbackIdentityPath(cacheDir: string): string {
	return join(cacheDir, 'cursor-inference', 'identity.json');
}

function parseFallbackIdentity(raw: string): string {
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		typeof value['machineId'] !== 'string' ||
		!uuidPattern.test(value['machineId'])
	) {
		throw new Error('Persisted Cursor fallback identity is invalid');
	}
	return value['machineId'];
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function loadOrCreateFallbackIdentity(
	cacheDir: string,
	createUuid: () => string,
): Promise<string> {
	const path = fallbackIdentityPath(cacheDir);
	try {
		return parseFallbackIdentity(await readFile(path, 'utf8'));
	} catch (error) {
		if (!isErrorCode(error, 'ENOENT')) throw error;
	}

	const machineId = createUuid();
	if (!uuidPattern.test(machineId))
		throw new Error('Generated Cursor fallback identity is invalid');
	await mkdir(join(cacheDir, 'cursor-inference'), { recursive: true });
	try {
		await writeFile(path, `${JSON.stringify({ machineId })}\n`, {
			encoding: 'utf8',
			flag: 'wx',
			mode: 0o600,
		});
		return machineId;
	} catch (error) {
		if (!isErrorCode(error, 'EEXIST')) throw error;
		return parseFallbackIdentity(await readFile(path, 'utf8'));
	}
}

/** Derive Cursor's host identity, persisting a random UUID only when host derivation fails. */
export async function loadCursorMachineIdentity(
	cacheDir: string,
	dependencies: IdentityDependencies = defaultDependencies,
): Promise<CursorMachineIdentity> {
	let machineId: string;
	let machineIdSource: CursorMachineIdentity['machineIdSource'];
	try {
		machineId = deriveHostMachineId(dependencies);
		machineIdSource = 'host';
	} catch {
		machineId = await loadOrCreateFallbackIdentity(cacheDir, dependencies.createUuid);
		machineIdSource = 'fallback';
	}
	const macMachineId = deriveMacMachineId(dependencies);
	return macMachineId === undefined
		? { machineId, machineIdSource }
		: { machineId, macMachineId, machineIdSource };
}
