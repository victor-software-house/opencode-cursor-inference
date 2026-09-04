export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function omitUndefined<T extends Record<string, unknown>>(
	value: T,
): {
	[Key in keyof T as undefined extends T[Key] ? Key : never]?: Exclude<T[Key], undefined>;
} & {
	[Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key];
};
export function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
