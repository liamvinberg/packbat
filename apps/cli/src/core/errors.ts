/**
 * An operational error whose message is written for the user. main() prints
 * the message (no stack) and exits 1. Anything else that escapes is a bug and
 * gets its stack printed.
 */
export class PackbatError extends Error {
	override name = "PackbatError";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
