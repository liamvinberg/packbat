import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { type OffboxConfig, type PackbatConfig, type RemoteConfig, remoteStatePath } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { isEnoent } from "../core/fs.js";
import type { PackbatHome } from "../core/home.js";
import { appendLog } from "../core/log.js";
import { writeAtomicJson } from "../core/stamps.js";
import { encryptToRecipient } from "./age.js";
import { createArchiveRemote } from "./remote.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDER = "If this laptop dies, sessions not copied off-box die with it.";

type ConfiguredOffbox = Extract<OffboxConfig, { mode: "configured" }>;

interface UploadedRecord {
	v: 1;
	path: string;
	mtimeMs: number;
	uploadedAt: string;
	recipient: string;
	destination: string;
	rcloneConfig: "managed" | "default";
}

interface ArchiveFile {
	path: string;
	absolutePath: string;
	mtimeMs: number;
}

interface IndexState {
	v: 1;
	hash: string;
	recipient: string;
}

export type RemotePublishOutcome =
	| { destination: string; ok: true; finishedAt: string; uploaded: number; bytes: number; indexUploaded: boolean }
	| { destination: string; ok: false; error: string };

function isUploadedRecord(value: unknown): value is UploadedRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.v === 1 &&
		typeof record.path === "string" &&
		typeof record.mtimeMs === "number" &&
		typeof record.uploadedAt === "string" &&
		typeof record.recipient === "string" &&
		typeof record.destination === "string" &&
		(record.rcloneConfig === "managed" || record.rcloneConfig === "default")
	);
}

export function parseUploadedRecords(contents: string): Map<string, UploadedRecord> {
	const records = new Map<string, UploadedRecord>();
	for (const line of contents.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			const value: unknown = JSON.parse(line);
			if (isUploadedRecord(value)) {
				records.set(value.path, value);
			}
		} catch {
			// Append-JSONL state is salvageable: valid later records still win.
		}
	}
	return records;
}

async function readUploadedRecords(path: string): Promise<Map<string, UploadedRecord>> {
	try {
		return parseUploadedRecords(await readFile(path, "utf8"));
	} catch (error) {
		if (isEnoent(error)) {
			return new Map();
		}
		throw error;
	}
}

async function readIndexState(path: string): Promise<IndexState | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			(value as Record<string, unknown>).v === 1 &&
			typeof (value as Record<string, unknown>).hash === "string" &&
			typeof (value as Record<string, unknown>).recipient === "string"
		) {
			return value as IndexState;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) {
			return null;
		}
		throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isEnoent(error)) {
			return false;
		}
		throw error;
	}
}

async function walkArchiveFiles(machinePath: string, machine: string): Promise<ArchiveFile[]> {
	const files: ArchiveFile[] = [];
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile()) {
				const pathFromMachine = relative(machinePath, child);
				if (pathFromMachine !== "index.jsonl") {
					files.push({
						path: join(machine, pathFromMachine),
						absolutePath: child,
						mtimeMs: (await stat(child)).mtimeMs,
					});
				}
			}
		}
	}
	await walk(machinePath);
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function encryptFile(source: string, destination: string, recipient: string): Promise<number> {
	await mkdir(dirname(destination), { recursive: true });
	const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`);
	try {
		const ciphertext = await encryptToRecipient(recipient, await readFile(source));
		await writeFile(temporary, ciphertext);
		await rename(temporary, destination);
		return ciphertext.byteLength;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function publishRemote(
	home: PackbatHome,
	config: PackbatConfig,
	offbox: ConfiguredOffbox,
	remoteConfig: RemoteConfig,
): Promise<RemotePublishOutcome> {
	const machinePath = join(config.archiveRoot, config.machine);
	const indexPath = join(machinePath, "index.jsonl");
	await mkdir(machinePath, { recursive: true });
	await writeFile(indexPath, "", { flag: "a" });

	const statePath = remoteStatePath(home, remoteConfig);
	const uploadedPath = join(statePath, "uploaded.jsonl");
	const successPath = join(statePath, "last-success.json");
	const indexStatePath = join(statePath, "index.json");
	const uploaded = await readUploadedRecords(uploadedPath);
	const previousIndex = await readIndexState(indexStatePath);
	const remote = createArchiveRemote(remoteConfig);
	const hasPublished = uploaded.size > 0 || previousIndex !== null || (await pathExists(successPath));
	if (!hasPublished && (await remote.indexExists(config.machine))) {
		// DRAFT copy
		throw new PackbatError(
			`an archive for machine \`${config.machine}\` already exists at the remote; restore it first (\`packbat restore --from-remote --identity <kit-file>\`) or change \`machine\` in config.json.`,
		);
	}
	const archiveFiles = await walkArchiveFiles(machinePath, config.machine);
	const changed = archiveFiles.filter((file) => {
		const previous = uploaded.get(file.path);
		return (
			previous === undefined ||
			previous.recipient !== offbox.recipient ||
			previous.destination !== remoteConfig.destination ||
			previous.rcloneConfig !== remoteConfig.rcloneConfig ||
			file.mtimeMs > previous.mtimeMs
		);
	});
	const outboxPath = join(statePath, "outbox");
	await rm(outboxPath, { recursive: true, force: true });

	let bytes = 0;
	for (const file of changed) {
		bytes += await encryptFile(file.absolutePath, join(outboxPath, `${file.path}.age`), offbox.recipient);
	}
	if (changed.length > 0) {
		await remote.putArchiveObjects(outboxPath);
	}

	const indexContents = await readFile(indexPath);
	const indexHash = createHash("sha256").update(indexContents).digest("hex");
	const indexChanged = previousIndex?.hash !== indexHash || previousIndex.recipient !== offbox.recipient;
	const encryptedIndexPath = join(outboxPath, config.machine, "index.jsonl.age");
	if (indexChanged) {
		await encryptFile(indexPath, encryptedIndexPath, offbox.recipient);
		await remote.putIndex(config.machine, encryptedIndexPath);
	}

	const finishedAt = new Date().toISOString();
	if (changed.length > 0) {
		await mkdir(statePath, { recursive: true });
		await appendFile(
			uploadedPath,
			`${changed
				.map((file) =>
					JSON.stringify({
						v: 1,
						path: file.path,
						mtimeMs: file.mtimeMs,
						uploadedAt: finishedAt,
						recipient: offbox.recipient,
						destination: remoteConfig.destination,
						rcloneConfig: remoteConfig.rcloneConfig,
					}),
				)
				.join("\n")}\n`,
		);
	}
	if (indexChanged) {
		await writeAtomicJson(indexStatePath, { v: 1, hash: indexHash, recipient: offbox.recipient });
	}
	await rm(outboxPath, { recursive: true, force: true });
	const result = {
		destination: remote.destination,
		finishedAt,
		uploaded: changed.length,
		bytes,
		indexUploaded: indexChanged,
	};
	await writeAtomicJson(successPath, result);
	return { ok: true, ...result };
}

export async function publishOffbox(
	home: PackbatHome,
	config: PackbatConfig,
	offbox: ConfiguredOffbox,
): Promise<RemotePublishOutcome[]> {
	const outcomes: RemotePublishOutcome[] = [];
	for (const remote of offbox.remotes) {
		try {
			outcomes.push(await publishRemote(home, config, offbox, remote));
		} catch (error) {
			outcomes.push({
				destination: remote.destination,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return outcomes;
}

export async function remindOffboxSkipped(home: PackbatHome, now: Date = new Date()): Promise<void> {
	const stampPath = join(home.statePath, "offbox-reminder.json");
	let remindedAtMs = Number.NaN;
	try {
		const value: unknown = JSON.parse(await readFile(stampPath, "utf8"));
		const remindedAt =
			typeof value === "object" && value !== null ? (value as Record<string, unknown>).remindedAt : undefined;
		if (typeof remindedAt === "string") {
			remindedAtMs = Date.parse(remindedAt);
		}
	} catch (error) {
		if (!isEnoent(error) && !(error instanceof SyntaxError)) {
			throw error;
		}
	}
	if (!Number.isNaN(remindedAtMs) && now.getTime() - remindedAtMs < WEEK_MS) {
		return;
	}
	await appendLog(home.logsPath, REMINDER, now);
	await writeAtomicJson(stampPath, { remindedAt: now.toISOString() });
}
