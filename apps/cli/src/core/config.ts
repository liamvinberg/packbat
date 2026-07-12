import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BlotterError } from "./errors.js";
import type { BlotterHome } from "./home.js";

export const CONFIG_VERSION = 1;

const remoteSchema = z.object({
	/** Full rclone destination, e.g. "blotter-remote:bucket/prefix" or an absolute local path. */
	destination: z.string().min(1),
	/** "managed" = blotter-owned rclone.conf; "default" = the user's own rclone config resolution. */
	rcloneConfig: z.enum(["managed", "default"]),
});

const offboxSchema = z.discriminatedUnion("mode", [
	z.object({
		/** Skipping off-box is a first-class answer, never an error state. */
		mode: z.literal("skipped"),
		skippedAt: z.iso.datetime(),
	}),
	z.object({
		mode: z.literal("configured"),
		/** age public recipient. The identity never lives on this machine after onboarding. */
		recipient: z.string().regex(/^age1[0-9a-z]+$/, "must be an age recipient (age1…)"),
		remote: remoteSchema,
	}),
]);

export const configSchema = z.strictObject({
	version: z.literal(CONFIG_VERSION),
	/**
	 * Locked at init (default: lowercase short hostname) so a later hostname
	 * change can never silently fork the archive tree. Machine trees are never
	 * merged.
	 */
	machine: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase and hostname-safe (a-z, 0-9, -)"),
	archiveRoot: z.string().refine((p) => p.startsWith("/"), "must be an absolute path"),
	sweep: z.object({
		intervalMinutes: z
			.number()
			.int()
			.min(5)
			.max(24 * 60),
	}),
	offbox: offboxSchema,
});

export type BlotterConfig = z.infer<typeof configSchema>;
export type OffboxConfig = BlotterConfig["offbox"];

export function loadConfig(home: BlotterHome): BlotterConfig {
	let raw: string;
	try {
		raw = readFileSync(home.configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new BlotterError(`no config at ${home.configPath} — run \`blotter init\` first`);
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new BlotterError(`${home.configPath} is not valid JSON: ${(error as Error).message}`);
	}
	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		throw new BlotterError(`${home.configPath} is invalid:\n${z.prettifyError(result.error)}`);
	}
	return result.data;
}

/** Atomic write: temp file in the same directory, then rename. */
export function saveConfig(home: BlotterHome, config: BlotterConfig): void {
	mkdirSync(dirname(home.configPath), { recursive: true });
	const tmp = join(dirname(home.configPath), `.config.json.tmp-${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`);
	renameSync(tmp, home.configPath);
}
