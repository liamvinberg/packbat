/**
 * Packbat Cloud lanes are disabled by default (ADR 0005). The code stays; only
 * the entry points are gated. PACKBAT_CLOUD=1 is the development arm.
 */
export function cloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PACKBAT_CLOUD?.trim() === "1";
}
