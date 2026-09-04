import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthOAuthResult, Hooks } from '@opencode-ai/plugin';
import { isRecord } from '@victor-software-house/pi-type-kit';

const loginUrl = 'https://cursor.com/loginDeepControl';
const pollUrl = 'https://api2.cursor.sh/auth/poll';
const refreshUrl = 'https://api2.cursor.sh/oauth/token';
const refreshClientId = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const pollIntervalMs = 500;
const pollWindowMs = 180_000;
const refreshDeadlineMs = 20_000;
const expirySkewMs = 5 * 60 * 1_000;

export interface CursorAuthRequest {
	readonly verifier: string;
	readonly challenge: string;
	readonly uuid: string;
	readonly url: string;
}

export interface CursorOAuthCredential {
	readonly type: 'oauth';
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
	readonly accountId?: string;
	readonly enterpriseUrl?: string;
}

export type CursorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CursorAuthDependencies {
	readonly fetch: CursorFetch;
	readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	readonly randomBytes: (size: number) => Uint8Array;
	readonly randomUuid: () => string;
	readonly now: () => number;
}

const dependencies: CursorAuthDependencies = {
	fetch,
	sleep: async (milliseconds, signal) => {
		await delay(milliseconds, undefined, { signal });
	},
	randomBytes,
	randomUuid: randomUUID,
	now: Date.now,
};

export interface CursorOAuthFlow {
	readonly url: string;
	readonly instructions: string;
	readonly callback: () => Promise<CursorOAuthCredential>;
}

function base64Url(value: Uint8Array): string {
	return Buffer.from(value).toString('base64url');
}

export function createCursorAuthRequest(
	deps: Pick<CursorAuthDependencies, 'randomBytes' | 'randomUuid'> = dependencies,
): CursorAuthRequest {
	const verifierBytes = deps.randomBytes(32);
	if (verifierBytes.byteLength !== 32) throw new Error('Cursor login verifier must be 32 bytes');
	const verifier = base64Url(verifierBytes);
	const challenge = base64Url(createHash('sha256').update(verifier, 'utf8').digest());
	const uuid = deps.randomUuid();
	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: 'login',
		supportsSelectedTeamLogin: 'true',
		redirectTarget: 'cli',
	});
	return { verifier, challenge, uuid, url: `${loginUrl}?${params.toString()}` };
}

function loginTokens(value: unknown): {
	readonly accessToken: string;
	readonly refreshToken: string;
} {
	if (
		!isRecord(value) ||
		typeof value['accessToken'] !== 'string' ||
		value['accessToken'] === '' ||
		typeof value['refreshToken'] !== 'string' ||
		value['refreshToken'] === ''
	) {
		throw new Error('Cursor authentication response is missing tokens');
	}
	return { accessToken: value['accessToken'], refreshToken: value['refreshToken'] };
}

function refreshedAccessToken(value: unknown): string {
	if (isRecord(value) && value['shouldLogout'] === true) {
		throw new Error('Cursor revoked this session; sign in again');
	}
	if (
		!isRecord(value) ||
		typeof value['access_token'] !== 'string' ||
		value['access_token'] === ''
	) {
		throw new Error('Cursor refresh response is missing an access token');
	}
	return value['access_token'];
}

export function cursorTokenExpiry(token: string): number {
	const payload = token.split('.')[1];
	if (payload === undefined || payload === '') throw new Error('Cursor access token is not a JWT');
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch (error) {
		throw new Error('Cursor access token has an invalid JWT payload', { cause: error });
	}
	if (
		!isRecord(decoded) ||
		typeof decoded['exp'] !== 'number' ||
		!Number.isSafeInteger(decoded['exp'])
	) {
		throw new Error('Cursor access token has no valid expiry');
	}
	return decoded['exp'] * 1_000;
}

function pollHeaders(): Record<string, string> {
	return {
		traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`,
		'x-ghost-mode': 'implicit-false',
		'x-new-onboarding-completed': 'false',
		'x-cursor-client-type': 'ide',
	};
}

class CursorSignInPolicyError extends Error {
	override name = 'CursorSignInPolicyError';
}

export async function pollCursorAuth(
	request: Pick<CursorAuthRequest, 'uuid' | 'verifier'>,
	signal: AbortSignal,
	deps: Pick<CursorAuthDependencies, 'fetch' | 'sleep' | 'now'> = dependencies,
): Promise<CursorOAuthCredential> {
	const deadline = deps.now() + pollWindowMs;
	while (!signal.aborted && deps.now() < deadline) {
		await deps.sleep(pollIntervalMs, signal);
		if (signal.aborted) break;
		try {
			const url = new URL(pollUrl);
			url.search = new URLSearchParams(request).toString();
			const response = await deps.fetch(url, { headers: pollHeaders(), signal });
			if (response.status === 404) continue;
			if (response.status === 403) {
				const body: unknown = await response.json().catch(() => undefined);
				if (isRecord(body) && typeof body['error'] === 'string') {
					throw new CursorSignInPolicyError(
						`Cursor login denied by sign-in policy: ${body['error']}`,
					);
				}
			}
			if (!response.ok) throw new Error(`Cursor login poll returned HTTP ${response.status}`);
			const result = loginTokens(await response.json());
			return {
				type: 'oauth',
				access: result.accessToken,
				refresh: result.refreshToken,
				expires: cursorTokenExpiry(result.accessToken),
			};
		} catch (error) {
			if (signal.aborted || error instanceof CursorSignInPolicyError) throw error;
		}
	}
	throw new Error('Cursor login polling timed out');
}

export async function refreshCursorToken(
	credential: CursorOAuthCredential,
	signal: AbortSignal = new AbortController().signal,
	request: CursorFetch = fetch,
): Promise<CursorOAuthCredential> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), refreshDeadlineMs);
	const abort = (): void => deadline.abort();
	if (signal.aborted) deadline.abort();
	else signal.addEventListener('abort', abort, { once: true });
	try {
		const response = await request(refreshUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-cursor-client-type': 'ide' },
			body: JSON.stringify({
				grant_type: 'refresh_token',
				client_id: refreshClientId,
				refresh_token: credential.refresh,
			}),
			signal: deadline.signal,
		});
		if (!response.ok) throw new Error(`Cursor token refresh returned HTTP ${response.status}`);
		const access = refreshedAccessToken(await response.json());
		return {
			...credential,
			access,
			expires: cursorTokenExpiry(access),
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', abort);
	}
}

export function isCursorOAuthCredential(value: unknown): value is CursorOAuthCredential {
	return (
		isRecord(value) &&
		value['type'] === 'oauth' &&
		typeof value['access'] === 'string' &&
		value['access'] !== '' &&
		typeof value['refresh'] === 'string' &&
		value['refresh'] !== '' &&
		typeof value['expires'] === 'number' &&
		Number.isFinite(value['expires'])
	);
}

export async function resolveCursorCredential(
	credential: CursorOAuthCredential,
	persist: (credential: CursorOAuthCredential) => Promise<void>,
	now: number = Date.now(),
): Promise<CursorOAuthCredential> {
	if (credential.expires - now > expirySkewMs) return credential;
	const refreshed = await refreshCursorToken(credential);
	await persist(refreshed);
	return refreshed;
}

export function createCursorOAuthFlow(
	deps: CursorAuthDependencies = dependencies,
): CursorOAuthFlow {
	const request = createCursorAuthRequest(deps);
	return {
		url: request.url,
		instructions: 'Complete Cursor sign-in in your browser.',
		callback: async () => await pollCursorAuth(request, new AbortController().signal, deps),
	};
}

export function cursorOAuthMethod(
	options: {
		readonly onSuccess?: (credential: CursorOAuthCredential) => Promise<void>;
		readonly dependencies?: CursorAuthDependencies;
	} = {},
): Extract<NonNullable<Hooks['auth']>['methods'][number], { type: 'oauth' }> {
	const deps = options.dependencies ?? dependencies;
	return {
		type: 'oauth',
		label: 'Cursor account (browser login)',
		async authorize(): Promise<AuthOAuthResult> {
			const flow = createCursorOAuthFlow(deps);
			return {
				url: flow.url,
				instructions: flow.instructions,
				method: 'auto',
				async callback() {
					const credential = await flow.callback();
					await options.onSuccess?.(credential);
					return {
						type: 'success',
						access: credential.access,
						refresh: credential.refresh,
						expires: credential.expires,
					};
				},
			};
		},
	};
}
