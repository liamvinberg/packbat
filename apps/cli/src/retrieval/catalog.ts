import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type FileRole, type HarnessId, isHarnessId, UUID_SOURCE } from "../adapters/adapter.js";
import { adapters } from "../adapters/registry.js";
import type { BlotterConfig } from "../core/config.js";
import { readDirectoryOrEmpty } from "../core/fs.js";
import { readIndex, type SessionArchiveIndexRecord } from "../core/index.js";
import type { ArchivedRetrievalFile, ArchivedRetrievalUnit } from "./types.js";

/**
 * Retrieval parses session files. A db-snapshot harness archives one whole
 * native database, which no reader understands yet, so its records and
 * payloads stay out of the catalog until that harness gets its own reader.
 */
const snapshotHarnesses: ReadonlySet<HarnessId> = new Set(
	adapters.filter((adapter) => adapter.mutationModel === "db-snapshot").map((adapter) => adapter.id),
);

const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const UUID_IN_FILENAME_PATTERN = new RegExp(`(${UUID_SOURCE})(?:\\.jsonl)?\\.zst$`, "i");

function portable(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

async function walkZstd(root: string, directory = root): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of (await readDirectoryOrEmpty(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await walkZstd(root, path)));
		} else if (entry.isFile() && entry.name.endsWith(".zst")) {
			paths.push(portable(relative(root, path)));
		}
	}
	return paths;
}

function inferUnit(harness: HarnessId, harnessPath: string): { id: string; role: FileRole } | null {
	const parts = harnessPath.split("/");
	if (harness === "claude-code") {
		const directoryId = parts.find((part) => UUID_PATTERN.test(part));
		if (directoryId !== undefined) {
			return { id: directoryId, role: "sidecar" };
		}
		const match = UUID_IN_FILENAME_PATTERN.exec(parts.at(-1) ?? "");
		return match?.[1] === undefined ? null : { id: match[1], role: "main" };
	}
	const match = UUID_IN_FILENAME_PATTERN.exec(parts.at(-1) ?? "");
	return match?.[1] === undefined ? null : { id: match[1], role: "main" };
}

function indexedFile(
	archiveRoot: string,
	machine: string,
	record: SessionArchiveIndexRecord,
	storedSize: number,
	storedMtimeMs: number,
): ArchivedRetrievalFile {
	const machinePath = portable(record.path);
	return {
		path: `${machine}/${machinePath}`,
		archivePath: join(archiveRoot, machine, ...machinePath.split("/")),
		machine,
		harness: record.harness,
		unit: record.unit,
		role: record.role,
		storedSize,
		storedMtimeMs,
		archiveSha256: record.sha256,
	};
}

function rawFile(
	archiveRoot: string,
	machine: string,
	machinePath: string,
	storedSize: number,
	storedMtimeMs: number,
): ArchivedRetrievalFile | null {
	const [harnessValue, ...rest] = machinePath.split("/");
	if (!isHarnessId(harnessValue) || snapshotHarnesses.has(harnessValue) || rest.length === 0) {
		return null;
	}
	const inferred = inferUnit(harnessValue, rest.join("/"));
	if (inferred === null) {
		return null;
	}
	return {
		path: `${machine}/${machinePath}`,
		archivePath: join(archiveRoot, machine, ...machinePath.split("/")),
		machine,
		harness: harnessValue,
		unit: inferred.id,
		role: inferred.role,
		storedSize,
		storedMtimeMs,
		archiveSha256: null,
	};
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

export async function readArchiveCatalog(
	config: BlotterConfig,
	options: { hashFiles?: boolean } = {},
): Promise<ArchivedRetrievalUnit[]> {
	const files = new Map<string, ArchivedRetrievalFile>();
	for (const machineEntry of (await readDirectoryOrEmpty(config.archiveRoot)).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!machineEntry.isDirectory()) {
			continue;
		}
		const machine = machineEntry.name;
		const machineRoot = join(config.archiveRoot, machine);
		const index = await readIndex(join(machineRoot, "index.jsonl"));
		const rawPaths = await walkZstd(machineRoot);
		const rawStats = new Map<string, { size: number; mtimeMs: number }>();
		for (const machinePath of rawPaths) {
			const stored = await stat(join(machineRoot, ...machinePath.split("/")));
			rawStats.set(machinePath, { size: stored.size, mtimeMs: stored.mtimeMs });
		}
		for (const record of index.records.values()) {
			if (record.machine !== machine || record.role === "database" || snapshotHarnesses.has(record.harness)) {
				continue;
			}
			const machinePath = portable(record.path);
			const stored = rawStats.get(machinePath);
			if (stored !== undefined) {
				const file = indexedFile(config.archiveRoot, machine, record, stored.size, stored.mtimeMs);
				files.set(file.path, file);
			}
		}
		for (const machinePath of rawPaths) {
			const path = `${machine}/${machinePath}`;
			if (files.has(path)) {
				continue;
			}
			const stored = rawStats.get(machinePath)!;
			const file = rawFile(config.archiveRoot, machine, machinePath, stored.size, stored.mtimeMs);
			if (file !== null) {
				files.set(file.path, file);
			}
		}
	}

	const units = new Map<string, ArchivedRetrievalUnit>();
	for (const file of files.values()) {
		const key = `${file.machine}/${file.harness}/${file.unit}`;
		const current = units.get(key);
		if (current === undefined) {
			units.set(key, { key, machine: file.machine, harness: file.harness, id: file.unit, files: [file] });
		} else {
			current.files.push(file);
		}
	}
	for (const unit of units.values()) {
		unit.files.sort((a, b) => (a.role === b.role ? a.path.localeCompare(b.path) : a.role === "main" ? -1 : 1));
		if (options.hashFiles) {
			for (const file of unit.files) {
				file.archiveSha256 = await sha256(file.archivePath);
			}
		}
	}
	return [...units.values()].sort((a, b) => a.key.localeCompare(b.key));
}
