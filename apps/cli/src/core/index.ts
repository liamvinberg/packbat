import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type FileRole, HARNESS_IDS, type HarnessId, isHarnessId, type SnapshotSession } from "../adapters/adapter.js";
import { readDirectoryOrEmpty, statOrNull } from "./fs.js";

interface ArchiveIndexRecordBase {
	v: 1;
	path: string;
	harness: HarnessId;
	machine: string;
	unit: string;
	source: string;
	sourceMtimeMs: number;
	sourceSize: number;
	storedSize: number;
	sha256: string;
	archivedAt: string;
}

export interface SessionArchiveIndexRecord extends ArchiveIndexRecordBase {
	role: FileRole;
}

export interface DatabaseSnapshotIndexRecord extends ArchiveIndexRecordBase {
	role: "database";
	contentSha256: string;
	snapshotAt: string;
	harnessVersion: string | null;
	sessions: SnapshotSession[];
}

export type ArchiveIndexRecord = SessionArchiveIndexRecord | DatabaseSnapshotIndexRecord;

export interface DatabaseSnapshotManifest {
	v: 1;
	kind: "db-snapshot";
	harness: HarnessId;
	sourcePath: string;
	harnessVersion: string | null;
	snapshotAt: string;
	contentSha256: string;
	sizeBytes: number;
	sessions: SnapshotSession[];
	payload: string;
}

export interface IndexContents {
	records: Map<string, ArchiveIndexRecord>;
	corruptLines: number;
}

function isSnapshotSession(value: unknown): value is SnapshotSession {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const session = value as Record<string, unknown>;
	return (
		typeof session.id === "string" && typeof session.timeCreated === "number" && typeof session.timeUpdated === "number"
	);
}

export function isDatabaseSnapshotManifest(value: unknown): value is DatabaseSnapshotManifest {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const manifest = value as Record<string, unknown>;
	return (
		manifest.v === 1 &&
		manifest.kind === "db-snapshot" &&
		isHarnessId(manifest.harness) &&
		typeof manifest.sourcePath === "string" &&
		(manifest.harnessVersion === null || typeof manifest.harnessVersion === "string") &&
		typeof manifest.snapshotAt === "string" &&
		typeof manifest.contentSha256 === "string" &&
		typeof manifest.sizeBytes === "number" &&
		Array.isArray(manifest.sessions) &&
		manifest.sessions.every(isSnapshotSession) &&
		typeof manifest.payload === "string" &&
		manifest.payload !== "" &&
		basename(manifest.payload) === manifest.payload &&
		!Number.isNaN(Date.parse(manifest.snapshotAt))
	);
}

function isArchiveIndexRecord(value: unknown): value is ArchiveIndexRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const common =
		record.v === 1 &&
		typeof record.path === "string" &&
		isHarnessId(record.harness) &&
		typeof record.machine === "string" &&
		typeof record.unit === "string" &&
		typeof record.source === "string" &&
		typeof record.sourceMtimeMs === "number" &&
		typeof record.sourceSize === "number" &&
		typeof record.storedSize === "number" &&
		typeof record.sha256 === "string" &&
		typeof record.archivedAt === "string";
	if (!common) {
		return false;
	}
	if (record.role === "main" || record.role === "sidecar") {
		return true;
	}
	return (
		record.role === "database" &&
		typeof record.contentSha256 === "string" &&
		typeof record.snapshotAt === "string" &&
		(record.harnessVersion === null || typeof record.harnessVersion === "string") &&
		Array.isArray(record.sessions) &&
		record.sessions.every(isSnapshotSession)
	);
}

export function isDatabaseSnapshotIndexRecord(record: ArchiveIndexRecord): record is DatabaseSnapshotIndexRecord {
	return record.role === "database";
}

export function parseIndex(contents: string): IndexContents {
	const records = new Map<string, ArchiveIndexRecord>();
	let corruptLines = 0;
	for (const line of contents.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			const record: unknown = JSON.parse(line);
			if (!isArchiveIndexRecord(record)) {
				corruptLines += 1;
				continue;
			}
			records.set(record.path, record);
		} catch {
			corruptLines += 1;
		}
	}
	return { records, corruptLines };
}

export async function readIndex(path: string): Promise<IndexContents> {
	try {
		return parseIndex(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { records: new Map(), corruptLines: 0 };
		}
		throw error;
	}
}

async function readSnapshotIndexRecords(machineRoot: string, machine: string): Promise<DatabaseSnapshotIndexRecord[]> {
	const records: DatabaseSnapshotIndexRecord[] = [];
	for (const harness of HARNESS_IDS) {
		const snapshotRoot = join(machineRoot, harness, "snapshots");
		const directories = (await readDirectoryOrEmpty(snapshotRoot)).filter((entry) => entry.isDirectory());
		for (const directory of directories) {
			let value: unknown;
			try {
				value = JSON.parse(await readFile(join(snapshotRoot, directory.name, "manifest.json"), "utf8")) as unknown;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
					continue;
				}
				throw error;
			}
			if (!isDatabaseSnapshotManifest(value) || value.harness !== harness) {
				continue;
			}
			const payloadPath = join(snapshotRoot, directory.name, value.payload);
			const payloadStat = await statOrNull(payloadPath);
			if (payloadStat === null || !payloadStat.isFile()) {
				continue;
			}
			const storedBytes = await readFile(payloadPath);
			records.push({
				v: 1,
				path: join(harness, "snapshots", directory.name, value.payload),
				harness,
				machine,
				unit: value.contentSha256,
				role: "database",
				source: value.sourcePath,
				sourceMtimeMs: Date.parse(value.snapshotAt),
				sourceSize: value.sizeBytes,
				storedSize: storedBytes.byteLength,
				sha256: createHash("sha256").update(storedBytes).digest("hex"),
				archivedAt: value.snapshotAt,
				contentSha256: value.contentSha256,
				snapshotAt: value.snapshotAt,
				harnessVersion: value.harnessVersion,
				sessions: value.sessions,
			});
		}
	}
	return records;
}

/** Read the rebuildable JSONL cache, then recover snapshot entries from their beside-payload manifests. */
export async function readDerivedIndex(machineRoot: string, machine: string): Promise<IndexContents> {
	const index = await readIndex(join(machineRoot, "index.jsonl"));
	for (const record of await readSnapshotIndexRecords(machineRoot, machine)) {
		index.records.set(record.path, record);
	}
	return index;
}

export async function appendIndex(path: string, record: ArchiveIndexRecord): Promise<void> {
	await appendFile(path, `${JSON.stringify(record)}\n`);
}
