import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PackbatError } from "./errors.js";
import type { PackbatHome } from "./home.js";

export const CONFIG_VERSION = 2;

const rcloneRemoteFields = {
	/** Full rclone destination, e.g. "packbat-remote:bucket/prefix" or an absolute local path. */
	destination: z.string().min(1),
	/** "managed" = Packbat-owned rclone.conf; "default" = the user's own rclone config resolution. */
	rcloneConfig: z.enum(["managed", "default"]),
} as const;

const rcloneRemoteSchema = z.strictObject({
	type: z.literal("rclone"),
	...rcloneRemoteFields,
});

const cloudRemoteSchema = z.strictObject({
	type: z.literal("cloud"),
	machineRemoteId: z.string().regex(/^[A-Za-z0-9_-]{24}$/u, "must be an opaque Packbat Cloud machine ID"),
});

const remoteSchema = z.discriminatedUnion("type", [rcloneRemoteSchema, cloudRemoteSchema]);

function schemaRemoteId(remote: z.infer<typeof remoteSchema>): string {
	return remote.type === "rclone" ? `rclone:${remote.destination}` : `cloud:${remote.machineRemoteId}`;
}

const remotesSchema = z.tuple([remoteSchema], remoteSchema).refine(
	(remotes) => new Set(remotes.map(schemaRemoteId)).size === remotes.length,
	"remote destinations must be unique", // DRAFT copy
);

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
		remotes: remotesSchema,
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

export type PackbatConfig = z.infer<typeof configSchema>;
export type OffboxConfig = PackbatConfig["offbox"];
export type RemoteConfig = Extract<OffboxConfig, { mode: "configured" }>["remotes"][number];

export function remoteDestination(remote: RemoteConfig): string {
	return remote.type === "rclone" ? remote.destination : "Packbat Cloud";
}

const legacyConfigSchema = z.strictObject({
	version: z.literal(1),
	machine: configSchema.shape.machine,
	archiveRoot: configSchema.shape.archiveRoot,
	sweep: configSchema.shape.sweep,
	offbox: z.discriminatedUnion("mode", [
		z.object({
			mode: z.literal("skipped"),
			skippedAt: z.iso.datetime(),
		}),
		z.object({
			mode: z.literal("configured"),
			recipient: z.string().regex(/^age1[0-9a-z]+$/, "must be an age recipient (age1…)"),
			remote: z.object(rcloneRemoteFields),
		}),
	]),
});

export function remoteStateId(remote: RemoteConfig): string {
	const stableIdentity =
		remote.type === "rclone" ? `${remote.type}\0${remote.destination}` : `${remote.type}\0${remote.machineRemoteId}`;
	return createHash("sha256").update(stableIdentity).digest("hex");
}

export function remoteStatePath(home: PackbatHome, remote: RemoteConfig): string {
	return join(home.statePath, "offbox", remoteStateId(remote));
}

function migrateLegacyState(home: PackbatHome, remote: RemoteConfig): void {
	const destination = remoteStatePath(home, remote);
	mkdirSync(destination, { recursive: true });
	for (const [legacyName, currentName] of [
		["offbox-uploaded.jsonl", "uploaded.jsonl"],
		["offbox-last-success.json", "last-success.json"],
	] as const) {
		const legacyPath = join(home.statePath, legacyName);
		if (!existsSync(legacyPath)) {
			continue;
		}
		const currentPath = join(destination, currentName);
		if (existsSync(currentPath)) {
			rmSync(legacyPath);
		} else {
			renameSync(legacyPath, currentPath);
		}
	}
	const legacyOutbox = join(home.statePath, "outbox");
	if (existsSync(legacyOutbox)) {
		const currentOutbox = join(destination, "outbox");
		if (existsSync(currentOutbox)) {
			rmSync(legacyOutbox, { recursive: true });
		} else {
			renameSync(legacyOutbox, currentOutbox);
		}
	}
}

function migrateLegacyConfig(home: PackbatHome, legacy: z.infer<typeof legacyConfigSchema>): PackbatConfig {
	const offbox: OffboxConfig =
		legacy.offbox.mode === "skipped"
			? legacy.offbox
			: {
					mode: "configured",
					recipient: legacy.offbox.recipient,
					remotes: [{ type: "rclone", ...legacy.offbox.remote }],
				};
	const migrated: PackbatConfig = { ...legacy, version: CONFIG_VERSION, offbox };
	if (migrated.offbox.mode === "configured") {
		migrateLegacyState(home, migrated.offbox.remotes[0]);
	}
	saveConfig(home, migrated);
	return migrated;
}

export function loadConfig(home: PackbatHome): PackbatConfig {
	let raw: string;
	try {
		raw = readFileSync(home.configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new PackbatError(`no config at ${home.configPath} — run \`packbat init\` first`);
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new PackbatError(`${home.configPath} is not valid JSON: ${(error as Error).message}`);
	}
	const result = configSchema.safeParse(parsed);
	if (result.success) {
		return result.data;
	}
	const legacy = legacyConfigSchema.safeParse(parsed);
	if (legacy.success) {
		return migrateLegacyConfig(home, legacy.data);
	}
	throw new PackbatError(`${home.configPath} is invalid:\n${z.prettifyError(result.error)}`);
}

/** Atomic write: temp file in the same directory, then rename. */
export function saveConfig(home: PackbatHome, config: PackbatConfig): void {
	mkdirSync(dirname(home.configPath), { recursive: true });
	const tmp = join(dirname(home.configPath), `.config.json.tmp-${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`);
	renameSync(tmp, home.configPath);
}
