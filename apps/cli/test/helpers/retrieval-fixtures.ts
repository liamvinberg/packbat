import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { FileRole, HarnessId } from "../../src/adapters/adapter.js";
import type { ArchiveIndexRecord } from "../../src/core/index.js";
import { makeTempHome } from "./run-cli.js";

export interface RetrievalLayout {
	home: string;
	packbatHome: string;
	archiveRoot: string;
	env: Record<string, string>;
}

export interface SyntheticArchiveFile {
	archivePath: string;
	indexPath: string;
	record: ArchiveIndexRecord;
}

export async function makeRetrievalLayout(): Promise<RetrievalLayout> {
	const home = await makeTempHome();
	const packbatHome = join(home, "packbat");
	const archiveRoot = join(home, "archive");
	await mkdir(packbatHome, { recursive: true });
	await writeFile(
		join(packbatHome, "config.json"),
		`${JSON.stringify({
			version: 1,
			machine: "test-machine",
			archiveRoot,
			sweep: { intervalMinutes: 60 },
			offbox: { mode: "skipped", skippedAt: "2026-01-02T03:04:05.000Z" },
		})}\n`,
	);
	return { home, packbatHome, archiveRoot, env: { PACKBAT_HOME: packbatHome } };
}

export async function writeArchivedJsonl(options: {
	layout: RetrievalLayout;
	machine?: string;
	harness: HarnessId;
	unit: string;
	relPath: string;
	role?: FileRole;
	lines: readonly (unknown | string)[];
	mtimeMs?: number;
	includeIndex?: boolean;
}): Promise<SyntheticArchiveFile> {
	const machine = options.machine ?? "test-machine";
	const role = options.role ?? "main";
	const raw = Buffer.from(
		`${options.lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
	);
	return await writeArchivedBytes({ ...options, machine, role, raw, includeIndex: options.includeIndex ?? true });
}

export async function writeArchivedBytes(options: {
	layout: RetrievalLayout;
	machine: string;
	harness: HarnessId;
	unit: string;
	relPath: string;
	role: FileRole;
	raw: Buffer;
	mtimeMs?: number;
	includeIndex: boolean;
	corruptZstd?: boolean;
}): Promise<SyntheticArchiveFile> {
	const relativePath = `${options.harness}/${options.relPath}.zst`;
	const archivePath = join(options.layout.archiveRoot, options.machine, relativePath);
	const stored = options.corruptZstd ? options.raw : zstdCompressSync(options.raw);
	await mkdir(dirname(archivePath), { recursive: true });
	await writeFile(archivePath, stored);
	if (options.mtimeMs !== undefined) {
		const date = new Date(options.mtimeMs);
		await utimes(archivePath, date, date);
	}
	const storedStats = await stat(archivePath);
	const record: ArchiveIndexRecord = {
		v: 1,
		path: relativePath,
		harness: options.harness,
		machine: options.machine,
		unit: options.unit,
		role: options.role,
		source: `/synthetic/${options.relPath}`,
		sourceMtimeMs: storedStats.mtimeMs,
		sourceSize: options.raw.byteLength,
		storedSize: stored.byteLength,
		sha256: createHash("sha256").update(stored).digest("hex"),
		archivedAt: "2026-01-02T03:04:05.000Z",
	};
	const indexPath = join(options.layout.archiveRoot, options.machine, "index.jsonl");
	if (options.includeIndex) {
		await mkdir(dirname(indexPath), { recursive: true });
		let existing = "";
		try {
			existing = await readFile(indexPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await writeFile(indexPath, `${existing}${JSON.stringify(record)}\n`);
	}
	return { archivePath, indexPath, record };
}
