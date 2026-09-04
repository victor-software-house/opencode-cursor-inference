import { homedir } from 'node:os';
import { join } from 'node:path';

export function openCodeCacheDir(environment: NodeJS.ProcessEnv = process.env): string {
	return join(environment.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'opencode');
}

export function openCodeDataDir(environment: NodeJS.ProcessEnv = process.env): string {
	return join(environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode');
}
