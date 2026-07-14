import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HarnessId } from "../adapters/adapter.js";
import { getAdapter } from "../adapters/registry.js";
import { decompressBytes } from "./compress.js";
import type { BlotterConfig } from "./config.js";
import { BlotterError, errorMessage } from "./errors.js";
import { type ArchiveIndexRecord, readIndex } from "./index.js";

interface ArchivedFile {
	record: ArchiveIndexRecord;
	relPath: string;
	archivePath: string;
}

export interface ArchivedUnit {
	id: string;
	harness: HarnessId;
	machine: string;
	files: ArchivedFile[];
	newestSourceMtimeMs: number;
	archived: boolean;
	supersededLocations: string[];
}

export interface RestoreResult {
	fileCount: number;
	targetRoot: string;
	resumeHints: string[];
}

interface RestorePlan {
	file: ArchivedFile;
	target: string;
}

function recordRelPath(record: ArchiveIndexRecord): string {
	const prefix = `${record.harness}${sep}`;
	if (!record.path.startsWith(prefix) || !record.path.endsWith(".zst")) {
		throw new BlotterError(`invalid archive path in index: ${record.path}`);
	}
	const relPath = record.path.slice(prefix.length, -".zst".length);
	if (relPath === "" || isAbsolute(relPath)) {
		throw new BlotterError(`invalid archive path in index: ${record.path}`);
	}
	return relPath;
}

function assertContained(root: string, path: string, label: string): void {
	const fromRoot = relative(resolve(root), resolve(path));
	if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new BlotterError(`${label} escapes its root: ${path}`);
	}
}

function compareRecordRecency(left: ArchiveIndexRecord, right: ArchiveIndexRecord): number {
	if (left.sourceMtimeMs !== right.sourceMtimeMs) {
		return left.sourceMtimeMs - right.sourceMtimeMs;
	}
	const archivedAt = left.archivedAt.localeCompare(right.archivedAt);
	return archivedAt !== 0 ? archivedAt : left.path.localeCompare(right.path);
}

function codexState(record: ArchiveIndexRecord): "active" | "archived" | null {
	const relPath = recordRelPath(record);
	if (relPath.startsWith(`sessions${sep}`)) {
		return "active";
	}
	if (relPath.startsWith(`archived_sessions${sep}`)) {
		return "archived";
	}
	return null;
}

function selectCodexState(records: ArchiveIndexRecord[]): {
	records: ArchiveIndexRecord[];
	supersededLocations: string[];
} {
	const hasActive = records.some((record) => codexState(record) === "active");
	const hasArchived = records.some((record) => codexState(record) === "archived");
	if (!hasActive || !hasArchived) {
		return { records, supersededLocations: [] };
	}
	const newest = records.reduce((current, record) => (compareRecordRecency(record, current) > 0 ? record : current));
	const selectedState = codexState(newest);
	const selected = records.filter((record) => codexState(record) === selectedState);
	const supersededLocations = records
		.filter((record) => codexState(record) !== selectedState)
		.map(recordRelPath)
		.sort((left, right) => left.localeCompare(right));
	return { records: selected, supersededLocations };
}

function toArchivedUnit(
	config: BlotterConfig,
	machine: string,
	harness: HarnessId,
	id: string,
	records: ArchiveIndexRecord[],
): ArchivedUnit {
	const selected = harness === "codex" ? selectCodexState(records) : { records, supersededLocations: [] };
	const machineRoot = join(config.archiveRoot, machine);
	const files = selected.records
		.map((record): ArchivedFile => {
			const archivePath = join(machineRoot, record.path);
			assertContained(machineRoot, archivePath, "archive path");
			return { record, relPath: recordRelPath(record), archivePath };
		})
		.sort((left, right) => {
			if (left.record.role !== right.record.role) {
				return left.record.role === "main" ? -1 : 1;
			}
			return left.relPath.localeCompare(right.relPath);
		});
	const newestSourceMtimeMs = Math.max(...files.map((file) => file.record.sourceMtimeMs));
	return {
		id,
		harness,
		machine,
		files,
		newestSourceMtimeMs,
		archived: harness === "codex" && files.some((file) => codexState(file.record) === "archived"),
		supersededLocations: selected.supersededLocations,
	};
}

export async function readArchivedUnits(config: BlotterConfig, machine: string): Promise<ArchivedUnit[]> {
	const indexPath = join(config.archiveRoot, machine, "index.jsonl");
	let records: ArchiveIndexRecord[];
	try {
		records = [...(await readIndex(indexPath)).records.values()].filter((record) => record.machine === machine);
	} catch (error) {
		throw new BlotterError(`could not read archive index for ${machine}: ${errorMessage(error)}`);
	}
	const groups = new Map<string, { harness: HarnessId; id: string; records: ArchiveIndexRecord[] }>();
	for (const record of records) {
		const key = `${record.harness}\0${record.unit}`;
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, { harness: record.harness, id: record.unit, records: [record] });
		} else {
			group.records.push(record);
		}
	}
	return [...groups.values()]
		.map((group) => toArchivedUnit(config, machine, group.harness, group.id, group.records))
		.sort(
			(left, right) =>
				right.newestSourceMtimeMs - left.newestSourceMtimeMs ||
				left.id.localeCompare(right.id) ||
				left.harness.localeCompare(right.harness),
		);
}

export function resolveArchivedUnit(units: readonly ArchivedUnit[], prefix: string): ArchivedUnit {
	const matchingIds = [...new Set(units.filter((unit) => unit.id.startsWith(prefix)).map((unit) => unit.id))].sort(
		(left, right) => left.localeCompare(right),
	);
	if (matchingIds.length === 0) {
		throw new BlotterError(`no archived unit matches "${prefix}"`);
	}
	if (matchingIds.length > 1) {
		throw new BlotterError(
			`archive prefix "${prefix}" is ambiguous:\n${matchingIds.map((id) => `  ${id}`).join("\n")}`,
		);
	}
	const id = matchingIds[0]!;
	const matches = units.filter((unit) => unit.id === id);
	if (matches.length !== 1) {
		throw new BlotterError(
			`archive id "${id}" exists in multiple harnesses:\n${matches
				.map((unit) => `  ${unit.id} (${unit.harness})`)
				.join("\n")}`,
		);
	}
	return matches[0]!;
}

async function liveMtime(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw new BlotterError(`could not inspect live target ${path}: ${errorMessage(error)}`);
	}
}

async function writeRestoredFile(plan: RestorePlan): Promise<void> {
	let archivedBytes: Buffer;
	try {
		archivedBytes = await readFile(plan.file.archivePath);
	} catch (error) {
		throw new BlotterError(`could not read archived file ${plan.file.archivePath}: ${errorMessage(error)}`);
	}
	const actualSha256 = createHash("sha256").update(archivedBytes).digest("hex");
	if (actualSha256 !== plan.file.record.sha256) {
		throw new BlotterError(`archived file is corrupt: ${plan.file.archivePath} (sha256 mismatch)`);
	}
	let bytes: Buffer;
	try {
		bytes = decompressBytes(archivedBytes);
	} catch (error) {
		throw new BlotterError(`could not read archived file ${plan.file.archivePath}: ${errorMessage(error)}`);
	}
	await mkdir(dirname(plan.target), { recursive: true });
	const temporary = join(dirname(plan.target), `.${basename(plan.target)}.tmp-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(temporary, bytes);
		await rename(temporary, plan.target);
		const mtimeSeconds = plan.file.record.sourceMtimeMs / 1000;
		await utimes(plan.target, mtimeSeconds, mtimeSeconds);
	} catch (error) {
		await rm(temporary, { force: true });
		throw new BlotterError(`could not restore ${plan.target}: ${errorMessage(error)}`);
	}
}

export async function restoreArchivedUnit(unit: ArchivedUnit, force: boolean): Promise<RestoreResult> {
	const adapter = getAdapter(unit.harness);
	if (adapter === undefined) {
		throw new BlotterError(`archive uses unsupported harness ${unit.harness}`);
	}
	const targetRoot = adapter.storeRoot(process.env, homedir());
	const plans = unit.files.map((file): RestorePlan => {
		const target = adapter.restoreTarget(targetRoot, file.relPath);
		assertContained(targetRoot, target, "restore target");
		return { file, target };
	});
	const targets = new Set<string>();
	for (const plan of plans) {
		if (targets.has(plan.target)) {
			throw new BlotterError(`archive maps more than one file to ${plan.target}`);
		}
		targets.add(plan.target);
	}

	const offenders: string[] = [];
	for (const plan of plans) {
		const mtimeMs = await liveMtime(plan.target);
		if (mtimeMs !== null && mtimeMs > plan.file.record.sourceMtimeMs) {
			offenders.push(plan.target);
		}
	}
	if (!force && offenders.length > 0) {
		throw new BlotterError(
			`restore would overwrite newer live files:\n${offenders.map((path) => `  ${path}`).join("\n")}`,
		);
	}

	for (const plan of plans) {
		await writeRestoredFile(plan);
	}
	return {
		fileCount: plans.length,
		targetRoot,
		resumeHints: adapter.resumeHint({ id: unit.id, relPaths: unit.files.map((file) => file.relPath) }),
	};
}
