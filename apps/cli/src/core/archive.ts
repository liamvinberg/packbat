import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HARNESS_IDS, type HarnessId, type SessionUnit } from "../adapters/adapter.js";
import { adapters } from "../adapters/registry.js";
import { compressFile } from "./compress.js";
import type { BlotterConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { type ArchiveIndexRecord, appendIndex, readIndex } from "./index.js";

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
		let units: SessionUnit[];
		try {
			units = await adapter.enumerate(adapter.storeRoot(env, userHome(env)));
		} catch (error) {
			increment(result, adapter.id, "failed");
			result.errors.push(`${adapter.id}: could not enumerate store: ${errorMessage(error)}`);
			continue;
		}
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
	return result;
}
