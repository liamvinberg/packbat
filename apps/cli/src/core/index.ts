import { appendFile, readFile } from "node:fs/promises";
import { type FileRole, type HarnessId, isHarnessId } from "../adapters/adapter.js";

export interface ArchiveIndexRecord {
	v: 1;
	path: string;
	harness: HarnessId;
	machine: string;
	unit: string;
	role: FileRole;
	source: string;
	sourceMtimeMs: number;
	sourceSize: number;
	storedSize: number;
	sha256: string;
	archivedAt: string;
}

export interface IndexContents {
	records: Map<string, ArchiveIndexRecord>;
	corruptLines: number;
}

function isArchiveIndexRecord(value: unknown): value is ArchiveIndexRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.v === 1 &&
		typeof record.path === "string" &&
		isHarnessId(record.harness) &&
		typeof record.machine === "string" &&
		typeof record.unit === "string" &&
		(record.role === "main" || record.role === "sidecar") &&
		typeof record.source === "string" &&
		typeof record.sourceMtimeMs === "number" &&
		typeof record.sourceSize === "number" &&
		typeof record.storedSize === "number" &&
		typeof record.sha256 === "string" &&
		typeof record.archivedAt === "string"
	);
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

export async function appendIndex(path: string, record: ArchiveIndexRecord): Promise<void> {
	await appendFile(path, `${JSON.stringify(record)}\n`);
}
