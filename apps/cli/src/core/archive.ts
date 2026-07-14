import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type DatabaseSnapshotHarnessAdapter,
	type DatabaseSnapshotUnit,
	HARNESS_IDS,
	type HarnessId,
	type SessionHarnessAdapter,
	type SessionUnit,
} from "../adapters/adapter.js";
import { adapters } from "../adapters/registry.js";
import { compressFile, decompressBytes } from "./compress.js";
import type { BlotterConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { readDirectoryOrEmpty, statOrNull } from "./fs.js";
import {
	type ArchiveIndexRecord,
	appendIndex,
	type DatabaseSnapshotIndexRecord,
	type DatabaseSnapshotManifest,
	isDatabaseSnapshotManifest,
	readIndex,
} from "./index.js";
import { writeAtomicJson } from "./stamps.js";

export interface ArchiveDecision {
	sourceMtimeMs: number;
	sourceSize: number;
	stored: { mtimeMs: number } | null;
	indexSourceSize: number | undefined;
}

export interface ArchiveCounts {
	archived: number;
	unchanged: number;
	failed: number;
}

export interface SweepResult extends ArchiveCounts {
	repaired: number;
	perHarness: Record<HarnessId, ArchiveCounts>;
	errors: string[];
}

export function shouldArchive(decision: ArchiveDecision): boolean {
	if (decision.stored === null) {
		return true;
	}
	if (decision.sourceMtimeMs > decision.stored.mtimeMs) {
		return true;
	}
	return (
		decision.sourceMtimeMs === decision.stored.mtimeMs &&
		decision.indexSourceSize !== undefined &&
		decision.sourceSize !== decision.indexSourceSize
	);
}

async function storedFile(path: string): Promise<{ mtimeMs: number } | null> {
	try {
		const storedStat = await stat(path);
		return { mtimeMs: storedStat.mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function emptyCounts(): ArchiveCounts {
	return { archived: 0, unchanged: 0, failed: 0 };
}

function emptyPerHarness(): Record<HarnessId, ArchiveCounts> {
	return Object.fromEntries(HARNESS_IDS.map((harness) => [harness, emptyCounts()])) as Record<HarnessId, ArchiveCounts>;
}

function increment(result: SweepResult, harness: HarnessId, field: keyof ArchiveCounts): void {
	result[field] += 1;
	result.perHarness[harness][field] += 1;
}

function userHome(env: NodeJS.ProcessEnv): string {
	const configured = env.HOME?.trim();
	return configured ? configured : homedir();
}

interface ExistingSnapshot {
	manifest: DatabaseSnapshotManifest;
	payloadPath: string;
	relativePayloadPath: string;
}

function utcBasic(isoTimestamp: string): string {
	return isoTimestamp.replaceAll("-", "").replaceAll(":", "");
}

async function newestSnapshot(
	machinePath: string,
	adapter: DatabaseSnapshotHarnessAdapter,
): Promise<ExistingSnapshot | null> {
	const snapshotRoot = join(machinePath, adapter.id, "snapshots");
	const entries = (await readDirectoryOrEmpty(snapshotRoot))
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => right.name.localeCompare(left.name));
	for (const entry of entries) {
		const directory = join(snapshotRoot, entry.name);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
				continue;
			}
			throw error;
		}
		if (
			!isDatabaseSnapshotManifest(value) ||
			value.harness !== adapter.id ||
			value.payload !== adapter.snapshotFilename
		) {
			continue;
		}
		const payloadPath = join(directory, value.payload);
		const payloadStat = await statOrNull(payloadPath);
		if (payloadStat === null || !payloadStat.isFile()) {
			continue;
		}
		try {
			const databaseBytes = decompressBytes(await readFile(payloadPath));
			if (
				databaseBytes.byteLength !== value.sizeBytes ||
				createHash("sha256").update(databaseBytes).digest("hex") !== value.contentSha256
			) {
				return null;
			}
		} catch {
			return null;
		}
		return {
			manifest: value,
			payloadPath,
			relativePayloadPath: join(adapter.id, "snapshots", entry.name, value.payload),
		};
	}
	return null;
}

async function snapshotIndexRecord(machine: string, snapshot: ExistingSnapshot): Promise<DatabaseSnapshotIndexRecord> {
	const storedBytes = await readFile(snapshot.payloadPath);
	return {
		v: 1,
		path: snapshot.relativePayloadPath,
		harness: snapshot.manifest.harness,
		machine,
		unit: snapshot.manifest.contentSha256,
		role: "database",
		source: snapshot.manifest.sourcePath,
		sourceMtimeMs: Date.parse(snapshot.manifest.snapshotAt),
		sourceSize: snapshot.manifest.sizeBytes,
		storedSize: storedBytes.byteLength,
		sha256: createHash("sha256").update(storedBytes).digest("hex"),
		archivedAt: snapshot.manifest.snapshotAt,
		contentSha256: snapshot.manifest.contentSha256,
		snapshotAt: snapshot.manifest.snapshotAt,
		harnessVersion: snapshot.manifest.harnessVersion,
		sessions: snapshot.manifest.sessions,
	};
}

async function archiveDatabaseSnapshot(
	config: BlotterConfig,
	machinePath: string,
	indexPath: string,
	index: Awaited<ReturnType<typeof readIndex>>,
	adapter: DatabaseSnapshotHarnessAdapter,
	unit: DatabaseSnapshotUnit,
	result: SweepResult,
): Promise<void> {
	const stagingRoot = join(machinePath, adapter.id, ".staging");
	const stagedDatabase = join(stagingRoot, `snapshot-${process.pid}-${randomUUID()}.db`);
	await mkdir(stagingRoot, { recursive: true });
	try {
		const capture = await adapter.snapshot(unit, stagedDatabase);
		const newest = await newestSnapshot(machinePath, adapter);
		if (newest?.manifest.contentSha256 === capture.contentSha256) {
			if (!index.records.has(newest.relativePayloadPath)) {
				const repaired = await snapshotIndexRecord(config.machine, newest);
				await appendIndex(indexPath, repaired);
				index.records.set(repaired.path, repaired);
				result.repaired += 1;
			}
			increment(result, adapter.id, "unchanged");
			return;
		}

		const snapshotAt = new Date().toISOString();
		const snapshotName = `${utcBasic(snapshotAt)}-${capture.contentSha256}`;
		const snapshotRoot = join(machinePath, adapter.id, "snapshots");
		const snapshotDirectory = join(snapshotRoot, snapshotName);
		await mkdir(snapshotRoot, { recursive: true });
		await mkdir(snapshotDirectory);
		const snapshotTime = Date.parse(snapshotAt) / 1000;
		await utimes(stagedDatabase, snapshotTime, snapshotTime);
		const payloadPath = join(snapshotDirectory, adapter.snapshotFilename);
		const compressed = await compressFile(stagedDatabase, payloadPath);
		const manifest: DatabaseSnapshotManifest = {
			v: 1,
			kind: "db-snapshot",
			harness: adapter.id,
			sourcePath: unit.sourcePath,
			harnessVersion: capture.softwareVersion,
			snapshotAt,
			contentSha256: capture.contentSha256,
			sizeBytes: capture.sizeBytes,
			sessions: capture.sessions,
			payload: adapter.snapshotFilename,
		};
		await writeAtomicJson(join(snapshotDirectory, "manifest.json"), manifest);
		const relativePayloadPath = join(adapter.id, "snapshots", snapshotName, adapter.snapshotFilename);
		const record: DatabaseSnapshotIndexRecord = {
			v: 1,
			path: relativePayloadPath,
			harness: adapter.id,
			machine: config.machine,
			unit: capture.contentSha256,
			role: "database",
			source: unit.sourcePath,
			sourceMtimeMs: compressed.sourceMtimeMs,
			sourceSize: capture.sizeBytes,
			storedSize: compressed.storedSize,
			sha256: compressed.sha256,
			archivedAt: snapshotAt,
			contentSha256: capture.contentSha256,
			snapshotAt,
			harnessVersion: capture.softwareVersion,
			sessions: capture.sessions,
		};
		await appendIndex(indexPath, record);
		index.records.set(record.path, record);
		increment(result, adapter.id, "archived");
	} catch (error) {
		increment(result, adapter.id, "failed");
		// DRAFT copy
		result.errors.push(`${adapter.id}: ${unit.sourcePath}: ${errorMessage(error)}`);
	} finally {
		await Promise.all([
			rm(stagedDatabase, { force: true }),
			rm(`${stagedDatabase}-wal`, { force: true }),
			rm(`${stagedDatabase}-shm`, { force: true }),
		]);
	}
}

async function archiveSessions(
	config: BlotterConfig,
	machinePath: string,
	indexPath: string,
	index: Awaited<ReturnType<typeof readIndex>>,
	adapter: SessionHarnessAdapter,
	units: SessionUnit[],
	result: SweepResult,
): Promise<void> {
	for (const unit of units) {
		for (const file of unit.files) {
			const relativePath = join(adapter.id, `${file.relPath}.zst`);
			const destination = join(machinePath, relativePath);
			try {
				const currentIndexRecord = index.records.get(relativePath);
				const stored = await storedFile(destination);
				if (
					!shouldArchive({
						sourceMtimeMs: file.mtimeMs,
						sourceSize: file.sizeBytes,
						stored,
						indexSourceSize: currentIndexRecord?.sourceSize,
					})
				) {
					if (stored !== null && currentIndexRecord?.sourceMtimeMs !== stored.mtimeMs) {
						const storedBytes = await readFile(destination);
						const record: ArchiveIndexRecord = {
							v: 1,
							path: relativePath,
							harness: adapter.id,
							machine: config.machine,
							unit: unit.id,
							role: file.role,
							source: file.absPath,
							sourceMtimeMs: stored.mtimeMs,
							sourceSize: file.sizeBytes,
							storedSize: storedBytes.byteLength,
							sha256: createHash("sha256").update(storedBytes).digest("hex"),
							archivedAt: new Date().toISOString(),
						};
						await appendIndex(indexPath, record);
						index.records.set(relativePath, record);
						result.repaired += 1;
					}
					increment(result, adapter.id, "unchanged");
					continue;
				}
				await mkdir(dirname(destination), { recursive: true });
				const compressed = await compressFile(file.absPath, destination);
				const record: ArchiveIndexRecord = {
					v: 1,
					path: relativePath,
					harness: adapter.id,
					machine: config.machine,
					unit: unit.id,
					role: file.role,
					source: file.absPath,
					sourceMtimeMs: compressed.sourceMtimeMs,
					sourceSize: compressed.sourceSize,
					storedSize: compressed.storedSize,
					sha256: compressed.sha256,
					archivedAt: new Date().toISOString(),
				};
				await appendIndex(indexPath, record);
				index.records.set(relativePath, record);
				increment(result, adapter.id, "archived");
			} catch (error) {
				increment(result, adapter.id, "failed");
				result.errors.push(`${adapter.id}: ${file.absPath}: ${errorMessage(error)}`);
			}
		}
	}
}

export async function sweep(config: BlotterConfig, env: NodeJS.ProcessEnv): Promise<SweepResult> {
	const result: SweepResult = {
		...emptyCounts(),
		repaired: 0,
		perHarness: emptyPerHarness(),
		errors: [],
	};
	const machinePath = join(config.archiveRoot, config.machine);
	const indexPath = join(machinePath, "index.jsonl");
	const index = await readIndex(indexPath);

	for (const adapter of adapters) {
		const storeRoot = adapter.storeRoot(env, userHome(env));
		if (adapter.mutationModel === "db-snapshot") {
			let units: DatabaseSnapshotUnit[];
			try {
				units = await adapter.enumerate(storeRoot);
			} catch (error) {
				increment(result, adapter.id, "failed");
				// DRAFT copy
				result.errors.push(`${adapter.id}: could not enumerate store: ${errorMessage(error)}`);
				continue;
			}
			for (const unit of units) {
				await archiveDatabaseSnapshot(config, machinePath, indexPath, index, adapter, unit, result);
			}
			continue;
		}

		let units: SessionUnit[];
		try {
			units = await adapter.enumerate(storeRoot);
		} catch (error) {
			increment(result, adapter.id, "failed");
			result.errors.push(`${adapter.id}: could not enumerate store: ${errorMessage(error)}`);
			continue;
		}
		await archiveSessions(config, machinePath, indexPath, index, adapter, units, result);
	}
	return result;
}
