type CursorShutdown = () => Promise<void>;

declare global {
	var opencodeCursorInferenceShutdown: CursorShutdown | undefined;
}

export function registerCursorShutdown(shutdown: CursorShutdown): void {
	globalThis.opencodeCursorInferenceShutdown = shutdown;
}

export async function disposeCursorProviders(): Promise<void> {
	await globalThis.opencodeCursorInferenceShutdown?.();
}
