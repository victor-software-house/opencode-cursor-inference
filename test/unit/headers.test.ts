import { describe, expect, test } from 'bun:test';
import { cursorChecksum, inferenceRequestHeaders, RUN_INFERENCE_PATH } from '@cursor/headers';
import type { CursorMachineIdentity } from '@cursor/identity';

const identity: CursorMachineIdentity = {
	machineId: 'a'.repeat(64),
	macMachineId: 'b'.repeat(64),
	machineIdSource: 'host',
};
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const clientKey = 'c'.repeat(64);

describe('Cursor inference headers', () => {
	test('matches the pinned checksum vector', () => {
		expect(cursorChecksum(identity, 1_700_000_000_000)).toBe(
			`Vfb45Bi9${'a'.repeat(64)}/${'b'.repeat(64)}`,
		);
	});

	test('omits the MAC suffix when Cursor cannot derive one', () => {
		expect(
			cursorChecksum({ machineId: 'a'.repeat(64), machineIdSource: 'fallback' }, 1_700_000_000_000),
		).toBe(`Vfb45Bi9${'a'.repeat(64)}`);
	});

	test('builds the complete managed-inference header set', () => {
		expect(
			inferenceRequestHeaders({
				token: 'fixture-token',
				ghostMode: false,
				identity,
				requestId,
				clientKey,
				nowMs: 1_700_000_000_000,
				timezone: 'America/Sao_Paulo',
				platform: 'linux',
				arch: 'x64',
			}),
		).toEqual({
			':method': 'POST',
			':path': RUN_INFERENCE_PATH,
			authorization: 'Bearer fixture-token',
			cookie: 'CursorCookie=Cookie-fixture-token',
			'connect-accept-encoding': 'gzip',
			'connect-content-encoding': 'gzip',
			'connect-protocol-version': '1',
			'content-type': 'application/connect+proto',
			'user-agent': 'connect-es/1.6.1',
			'x-amzn-trace-id': `Root=${requestId}`,
			'x-client-key': clientKey,
			'x-cursor-checksum': `Vfb45Bi9${'a'.repeat(64)}/${'b'.repeat(64)}`,
			'x-cursor-client-arch': 'x64',
			'x-cursor-client-commit': '2ba48ff3f7514cc4643c52ca9f7b3173d9b66130',
			'x-cursor-client-device-type': 'desktop',
			'x-cursor-client-os': 'linux',
			'x-cursor-client-type': 'ide',
			'x-cursor-client-version': '3.18.9',
			'x-cursor-streaming': 'true',
			'x-cursor-timezone': 'America/Sao_Paulo',
			'x-ghost-mode': 'false',
			'x-new-onboarding-completed': 'false',
			'x-request-id': requestId,
		});
	});

	test('rejects credential and generated-header injection', () => {
		const base = {
			token: 'token',
			ghostMode: true,
			identity,
			requestId,
			clientKey,
		};
		expect(() => inferenceRequestHeaders({ ...base, token: 'token\r\nattack' })).toThrow(
			'Cursor credential contains a line break',
		);
		expect(() => inferenceRequestHeaders({ ...base, timezone: 'UTC\nattack' })).toThrow(
			'Cursor timezone contains a line break',
		);
		expect(() => inferenceRequestHeaders({ ...base, requestId: 'not-a-uuid' })).toThrow(
			'Cursor request id must be a UUID',
		);
		expect(() => inferenceRequestHeaders({ ...base, clientKey: 'ABC' })).toThrow(
			'Cursor client key must be 32-byte lowercase hex',
		);
	});
});
