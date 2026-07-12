/**
 * An operational error whose message is written for the user. main() prints
 * the message (no stack) and exits 1. Anything else that escapes is a bug and
 * gets its stack printed.
 */
export class BlotterError extends Error {
	override name = "BlotterError";
}
