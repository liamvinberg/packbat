import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { BlotterConfig, OffboxConfig } from "../core/config.js";
import { BlotterError } from "../core/errors.js";
import type { BlotterHome } from "../core/home.js";
import { appendLog } from "../core/log.js";
import { writeAtomicJson } from "../core/stamps.js";
import { encryptToRecipient } from "./age.js";
import { copyFile, copyTree, joinRcloneDestination, remoteFileExists } from "./rclone.js";

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
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return new Map();
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

export async function publishOffbox(home: BlotterHome, config: BlotterConfig, offbox: ConfiguredOffbox): Promise<void> {
	const machinePath = join(config.archiveRoot, config.machine);
	const indexPath = join(machinePath, "index.jsonl");
	await mkdir(machinePath, { recursive: true });
	await writeFile(indexPath, "", { flag: "a" });

	const uploadedPath = join(home.statePath, "offbox-uploaded.jsonl");
	const uploaded = await readUploadedRecords(uploadedPath);
	const remoteIndexPath = joinRcloneDestination(offbox.remote.destination, `${config.machine}/index.jsonl.age`);
	if (uploaded.size === 0 && (await remoteFileExists(remoteIndexPath, offbox.remote.rcloneConfig))) {
		throw new BlotterError(
			`an archive for machine \`${config.machine}\` already exists at the remote; restore it first (\`blotter restore --from-remote --identity <kit-file>\`) or change \`machine\` in config.json.`,
		);
	}
	const archiveFiles = await walkArchiveFiles(machinePath, config.machine);
	const changed = archiveFiles.filter((file) => {
		const previous = uploaded.get(file.path);
		return (
			previous === undefined ||
			previous.recipient !== offbox.recipient ||
			previous.destination !== offbox.remote.destination ||
			previous.rcloneConfig !== offbox.remote.rcloneConfig ||
			file.mtimeMs > previous.mtimeMs
		);
	});
	const outboxPath = join(home.statePath, "outbox");
	await rm(outboxPath, { recursive: true, force: true });

	let bytes = 0;
	for (const file of changed) {
		bytes += await encryptFile(file.absolutePath, join(outboxPath, `${file.path}.age`), offbox.recipient);
	}
	if (changed.length > 0) {
		await copyTree(outboxPath, offbox.remote.destination, offbox.remote.rcloneConfig);
	}

	const encryptedIndexPath = join(outboxPath, config.machine, "index.jsonl.age");
	await encryptFile(indexPath, encryptedIndexPath, offbox.recipient);
	await copyFile(encryptedIndexPath, remoteIndexPath, offbox.remote.rcloneConfig);

	const finishedAt = new Date().toISOString();
	if (changed.length > 0) {
		await mkdir(home.statePath, { recursive: true });
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
						destination: offbox.remote.destination,
						rcloneConfig: offbox.remote.rcloneConfig,
					}),
				)
				.join("\n")}\n`,
		);
	}
	await rm(outboxPath, { recursive: true, force: true });
	const result = { finishedAt, uploaded: changed.length, bytes };
	await writeAtomicJson(join(home.statePath, "offbox-last-success.json"), result);
}

export async function remindOffboxSkipped(home: BlotterHome, now: Date = new Date()): Promise<void> {
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
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
			throw error;
		}
	}
	if (!Number.isNaN(remindedAtMs) && now.getTime() - remindedAtMs < WEEK_MS) {
		return;
	}
	await appendLog(home.logsPath, REMINDER, now);
	await writeAtomicJson(stampPath, { remindedAt: now.toISOString() });
}
