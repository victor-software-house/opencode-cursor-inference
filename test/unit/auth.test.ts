import { describe, expect, test } from 'bun:test';
import {
	type CursorOAuthCredential,
	createCursorAuthRequest,
	cursorTokenExpiry,
	pollCursorAuth,
	resolveCursorCredential,
} from '@cursor/auth';

function token(exp: number): string {
	return `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
}

describe('Cursor OpenCode OAuth', () => {
	test('creates a PKCE browser login request without storing verifier material', () => {
		const request = createCursorAuthRequest({
			randomBytes: () => new Uint8Array(32).fill(7),
			randomUuid: () => '123e4567-e89b-42d3-a456-426614174000',
		});
		const url = new URL(request.url);
		expect(url.origin + url.pathname).toBe('https://cursor.com/loginDeepControl');
		expect(url.searchParams.get('uuid')).toBe('123e4567-e89b-42d3-a456-426614174000');
		expect(url.searchParams.get('challenge')).not.toBe(request.verifier);
		expect(url.searchParams.get('redirectTarget')).toBe('cli');
	});

	test('polls deterministically and returns OpenCode OAuth credential fields', async () => {
		const responses = [
			new Response(undefined, { status: 404 }),
			Response.json({ accessToken: token(2_000_000_000), refreshToken: 'refresh-token' }),
		];
		const credential = await pollCursorAuth(
			{ uuid: 'uuid', verifier: 'verifier' },
			new AbortController().signal,
			{
				fetch: async () => responses.shift() ?? new Response(undefined, { status: 500 }),
				sleep: async () => undefined,
				now: () => 1_000,
			},
		);
		expect(credential).toEqual({
			type: 'oauth',
			access: token(2_000_000_000),
			refresh: 'refresh-token',
			expires: 2_000_000_000_000,
		});
	});

	test('validates JWT expiry and leaves fresh credentials in OpenCode ownership', async () => {
		expect(cursorTokenExpiry(token(123))).toBe(123_000);
		const credential: CursorOAuthCredential = {
			type: 'oauth',
			access: token(2_000_000_000),
			refresh: 'refresh',
			expires: 2_000_000_000_000,
		};
		let writes = 0;
		expect(
			await resolveCursorCredential(
				credential,
				async () => {
					writes += 1;
				},
				1_000,
			),
		).toBe(credential);
		expect(writes).toBe(0);
	});
});
