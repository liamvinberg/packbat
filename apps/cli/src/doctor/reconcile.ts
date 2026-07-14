import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { HARNESS_IDS, type HarnessId, isHarnessId, type SessionFile } from "../adapters/adapter.js";
import { adapters } from "../adapters/registry.js";
import { shouldArchive } from "../core/archive.js";
import { readDirectoryOrEmpty, statOrNull } from "../core/fs.js";
import { type IndexContents, readIndex } from "../core/index.js";
import type { DoctorContext, Fact } from "./facts.js";
import { ageMs, windowMs } from "./facts.js";

interface HarnessReconciliation {
	sources: number;
	archived: number;
	missing: number;
	stale: number;
	pending: number;
	orphaned: number;
}

interface IndexDrift {
	unindexed: number;
	missingFromTree: number;
	metadataMismatch: number;
	corruptLines: number;
}

interface SourceEntry {
	harness: HarnessId;
	file: SessionFile;
	archivePath: string;
	relativeArchivePath: string;
}

function emptyHarness(): HarnessReconciliation {
	return { sources: 0, archived: 0, missing: 0, stale: 0, pending: 0, orphaned: 0 };
}

function harnessRecord(): Record<HarnessId, HarnessReconciliation> {
	return Object.fromEntries(HARNESS_IDS.map((harness) => [harness, emptyHarness()])) as Record<
		HarnessId,
		HarnessReconciliation
	>;
}

async function walkFiles(root: string): Promise<string[]> {
	const entries = await readDirectoryOrEmpty(root);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(path)));
		} else {
			files.push(path);
		}
	}
	return files;
}

async function storedMtime(path: string): Promise<number | null> {
	return (await statOrNull(path))?.mtimeMs ?? null;
}

async function sourceExists(path: string): Promise<boolean> {
	return (await statOrNull(path)) !== null;
}

function archivedSourcePath(
	archiveRelativePath: string,
	storeRoots: ReadonlyMap<HarnessId, string>,
): { harness: HarnessId; sourcePath: string } | null {
	const parts = archiveRelativePath.split(sep);
	const harness = parts.shift();
	if (!isHarnessId(harness)) {
		return null;
	}
	const last = parts.at(-1);
	if (last === undefined || !last.endsWith(".zst")) {
		return null;
	}
	parts[parts.length - 1] = last.slice(0, -4);
	const root = storeRoots.get(harness);
	return root === undefined ? null : { harness, sourcePath: join(root, ...parts) };
}

function anomalyDetail(harnesses: Record<HarnessId, HarnessReconciliation>): string[] {
	const details: string[] = [];
	for (const adapter of adapters) {
		const data = harnesses[adapter.id];
		const items: string[] = [];
		for (const key of ["missing", "stale", "pending", "orphaned"] as const) {
			if (data[key] > 0) {
				items.push(`${data[key]} ${key}`);
			}
		}
		if (items.length > 0) {
			details.push(`${adapter.id}: ${items.join(", ")}`);
		}
	}
	return details;
}

export async function checkReconciled(context: DoctorContext): Promise<Fact> {
	const machinePath = join(context.config.archiveRoot, context.config.machine);
	const indexPath = join(machinePath, "index.jsonl");
	const harnesses = harnessRecord();
	const storeRoots = new Map<HarnessId, string>();
	const sources: SourceEntry[] = [];
	const enumerationErrors: string[] = [];
	const reconciliationErrors: string[] = [];

	for (const adapter of adapters) {
		const storeRoot = adapter.storeRoot(context.env, context.userHome);
		storeRoots.set(adapter.id, storeRoot);
		try {
			for (const unit of await adapter.enumerate(storeRoot)) {
				for (const file of unit.files) {
					const relativeArchivePath = join(adapter.id, `${file.relPath}.zst`);
					sources.push({
						harness: adapter.id,
						file,
						archivePath: join(machinePath, relativeArchivePath),
						relativeArchivePath,
					});
					harnesses[adapter.id].sources += 1;
				}
			}
		} catch (error) {
			enumerationErrors.push(`${adapter.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	let treeFiles: string[];
	let index: IndexContents;
	try {
		[treeFiles, index] = await Promise.all([walkFiles(machinePath), readIndex(indexPath)]);
	} catch (error) {
		return {
			id: "reconciled",
			title: "reconciled",
			status: "problem",
			detail: `archive tree cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			data: { harnesses, enumerationErrors },
		};
	}
	const archiveFiles = treeFiles.filter((path) => relative(machinePath, path) !== "index.jsonl");
	const treeRelative = archiveFiles.map((path) => relative(machinePath, path));
	const treeSet = new Set(treeRelative);
	for (const archiveRelativePath of treeRelative) {
		const harness = archiveRelativePath.split(sep, 1)[0];
		if (isHarnessId(harness)) {
			harnesses[harness].archived += 1;
		}
	}

	for (const source of sources) {
		let mtimeMs: number | null;
		try {
			mtimeMs = await storedMtime(source.archivePath);
		} catch (error) {
			reconciliationErrors.push(
				`${source.harness}: cannot inspect ${source.archivePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (mtimeMs === null) {
			if (ageMs(source.file.mtimeMs, context.now) < windowMs(context)) {
				harnesses[source.harness].pending += 1;
			} else {
				harnesses[source.harness].missing += 1;
			}
			continue;
		}
		const stale = shouldArchive({
			sourceMtimeMs: source.file.mtimeMs,
			sourceSize: source.file.sizeBytes,
			stored: { mtimeMs },
			indexSourceSize: index.records.get(source.relativeArchivePath)?.sourceSize,
		});
		if (!stale) {
			continue;
		}
		if (ageMs(source.file.mtimeMs, context.now) < windowMs(context)) {
			harnesses[source.harness].pending += 1;
		} else {
			harnesses[source.harness].stale += 1;
		}
	}

	for (const archiveRelativePath of treeRelative) {
		const derived = archivedSourcePath(archiveRelativePath, storeRoots);
		if (derived !== null) {
			try {
				if (!(await sourceExists(derived.sourcePath))) {
					harnesses[derived.harness].orphaned += 1;
				}
			} catch (error) {
				reconciliationErrors.push(
					`${derived.harness}: cannot inspect ${derived.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	let metadataMismatch = 0;
	for (const archiveRelativePath of treeRelative) {
		const record = index.records.get(archiveRelativePath);
		if (record === undefined) {
			continue;
		}
		try {
			const archiveStat = await stat(join(machinePath, archiveRelativePath));
			if (archiveStat.size !== record.storedSize || archiveStat.mtimeMs !== record.sourceMtimeMs) {
				metadataMismatch += 1;
			}
		} catch (error) {
			reconciliationErrors.push(
				`index: cannot inspect ${archiveRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const indexDrift: IndexDrift = {
		unindexed: treeRelative.filter((path) => !index.records.has(path)).length,
		missingFromTree: [...index.records.keys()].filter((path) => !treeSet.has(path)).length,
		metadataMismatch,
		corruptLines: index.corruptLines,
	};
	const totals = Object.values(harnesses).reduce(
		(result, value) => ({
			sources: result.sources + value.sources,
			archived: result.archived + value.archived,
			missing: result.missing + value.missing,
			stale: result.stale + value.stale,
			pending: result.pending + value.pending,
			orphaned: result.orphaned + value.orphaned,
		}),
		emptyHarness(),
	);
	const driftCount =
		indexDrift.unindexed + indexDrift.missingFromTree + indexDrift.metadataMismatch + indexDrift.corruptLines;
	const hasProblem =
		totals.missing > 0 ||
		totals.stale > 0 ||
		indexDrift.missingFromTree > 0 ||
		enumerationErrors.length > 0 ||
		reconciliationErrors.length > 0;
	const hasInfo = totals.pending > 0 || totals.orphaned > 0 || driftCount > 0;
	const details = anomalyDetail(harnesses);
	if (enumerationErrors.length > 0) {
		details.push(`enumeration failed: ${enumerationErrors.join("; ")}`);
	}
	if (reconciliationErrors.length > 0) {
		details.push(`inspection failed: ${reconciliationErrors.join("; ")}`);
	}
	if (driftCount > 0) {
		details.push(`index drift: ${driftCount}`);
	}
	if (indexDrift.missingFromTree > 0) {
		details.push("archived payloads recorded in the index are missing from the tree");
	}
	const detail =
		details.length === 0
			? `nothing missed; ${totals.sources} source file${totals.sources === 1 ? "" : "s"} current`
			: `${hasProblem ? "coverage gaps" : "nothing missed"}; ${details.join("; ")}`;
	return {
		id: "reconciled",
		title: "reconciled",
		status: hasProblem ? "problem" : hasInfo ? "info" : "ok",
		detail,
		data: {
			windowMinutes: context.config.sweep.intervalMinutes * 2,
			totals,
			harnesses,
			indexDrift,
			enumerationErrors,
			reconciliationErrors,
		},
	};
}
