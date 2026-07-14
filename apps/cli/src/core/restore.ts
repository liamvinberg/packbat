import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HarnessId } from "../adapters/adapter.js";
import { getAdapter } from "../adapters/registry.js";
import { decompressBytes } from "./compress.js";
import type { PackbatConfig } from "./config.js";
import { errorMessage, PackbatError } from "./errors.js";
import {
	type ArchiveIndexRecord,
	type DatabaseSnapshotIndexRecord,
	isDatabaseSnapshotIndexRecord,
	readDerivedIndex,
} from "./index.js";

interface ArchivedFile {
	record: ArchiveIndexRecord;
	relPath: string;
	archivePath: string;
}

export interface ArchivedUnit {
	kind: "session" | "db-snapshot";
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
		throw new PackbatError(`invalid archive path in index: ${record.path}`);
	}
	const relPath = record.path.slice(prefix.length, -".zst".length);
	if (relPath === "" || isAbsolute(relPath)) {
		throw new PackbatError(`invalid archive path in index: ${record.path}`);
	}
	return relPath;
}

function assertContained(root: string, path: string, label: string): void {
	const fromRoot = relative(resolve(root), resolve(path));
	if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new PackbatError(`${label} escapes its root: ${path}`);
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
	config: PackbatConfig,
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
		kind: "session",
		id,
		harness,
		machine,
		files,
		newestSourceMtimeMs,
		archived: harness === "codex" && files.some((file) => codexState(file.record) === "archived"),
		supersededLocations: selected.supersededLocations,
	};
}

function toArchivedSnapshotUnit(
	config: PackbatConfig,
	machine: string,
	id: string,
	record: DatabaseSnapshotIndexRecord,
): ArchivedUnit {
	const machineRoot = join(config.archiveRoot, machine);
	const archivePath = join(machineRoot, record.path);
	assertContained(machineRoot, archivePath, "archive path");
	return {
		kind: "db-snapshot",
		id,
		harness: record.harness,
		machine,
		files: [{ record, relPath: recordRelPath(record), archivePath }],
		newestSourceMtimeMs: record.sourceMtimeMs,
		archived: false,
		supersededLocations: [],
	};
}

function attachGeminiProjectMarkers(
	groups: Map<string, { harness: HarnessId; id: string; records: ArchiveIndexRecord[] }>,
): void {
	const markers = new Map<string, ArchiveIndexRecord>();
	for (const group of groups.values()) {
		if (group.harness !== "gemini") {
			continue;
		}
		for (const record of group.records) {
			const parts = recordRelPath(record).split(sep);
			if (parts.length === 2 && parts[1] === ".project_root") {
				markers.set(parts[0]!, record);
			}
		}
	}
	for (const group of groups.values()) {
		if (group.harness !== "gemini") {
			continue;
		}
		const main = group.records.find((record) => record.role === "main");
		if (main === undefined) {
			continue;
		}
		const parts = recordRelPath(main).split(sep);
		const marker = parts[1] === "chats" ? markers.get(parts[0]!) : undefined;
		if (marker !== undefined && !group.records.some((record) => record.path === marker.path)) {
			// One physical project locator is shared by every session in the slug.
			group.records.push(marker);
		}
	}
}

export async function readArchivedUnits(config: PackbatConfig, machine: string): Promise<ArchivedUnit[]> {
	let records: ArchiveIndexRecord[];
	try {
		records = [...(await readDerivedIndex(join(config.archiveRoot, machine), machine)).records.values()].filter(
			(record) => record.machine === machine,
		);
	} catch (error) {
		throw new PackbatError(`could not read archive index for ${machine}: ${errorMessage(error)}`);
	}
	const groups = new Map<string, { harness: HarnessId; id: string; records: ArchiveIndexRecord[] }>();
	for (const record of records.filter((record) => !isDatabaseSnapshotIndexRecord(record))) {
		const key = `${record.harness}\0${record.unit}`;
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, { harness: record.harness, id: record.unit, records: [record] });
		} else {
			group.records.push(record);
		}
	}
	attachGeminiProjectMarkers(groups);
	const newestSnapshots = new Map<string, { id: string; record: DatabaseSnapshotIndexRecord }>();
	for (const record of records.filter(isDatabaseSnapshotIndexRecord)) {
		for (const session of record.sessions) {
			const key = `${record.harness}\0${session.id}`;
			const current = newestSnapshots.get(key);
			if (current === undefined || compareRecordRecency(record, current.record) > 0) {
				newestSnapshots.set(key, { id: session.id, record });
			}
		}
	}
	return [
		...[...groups.values()].map((group) => toArchivedUnit(config, machine, group.harness, group.id, group.records)),
		...[...newestSnapshots.values()].map(({ id, record }) => toArchivedSnapshotUnit(config, machine, id, record)),
	].sort(
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
		throw new PackbatError(`no archived unit matches "${prefix}"`);
	}
	if (matchingIds.length > 1) {
		throw new PackbatError(
			`archive prefix "${prefix}" is ambiguous:\n${matchingIds.map((id) => `  ${id}`).join("\n")}`,
		);
	}
	const id = matchingIds[0]!;
	const matches = units.filter((unit) => unit.id === id);
	if (matches.length !== 1) {
		throw new PackbatError(
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
		throw new PackbatError(`could not inspect live target ${path}: ${errorMessage(error)}`);
	}
}

async function writeRestoredFile(plan: RestorePlan): Promise<void> {
	let archivedBytes: Buffer;
	try {
		archivedBytes = await readFile(plan.file.archivePath);
	} catch (error) {
		throw new PackbatError(`could not read archived file ${plan.file.archivePath}: ${errorMessage(error)}`);
	}
	const actualSha256 = createHash("sha256").update(archivedBytes).digest("hex");
	if (actualSha256 !== plan.file.record.sha256) {
		throw new PackbatError(`archived file is corrupt: ${plan.file.archivePath} (sha256 mismatch)`);
	}
	let bytes: Buffer;
	try {
		bytes = decompressBytes(archivedBytes);
	} catch (error) {
		throw new PackbatError(`could not read archived file ${plan.file.archivePath}: ${errorMessage(error)}`);
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
		throw new PackbatError(`could not restore ${plan.target}: ${errorMessage(error)}`);
	}
}

async function archivedPayload(file: ArchivedFile): Promise<Buffer> {
	let archivedBytes: Buffer;
	try {
		archivedBytes = await readFile(file.archivePath);
	} catch (error) {
		throw new PackbatError(`could not read archived file ${file.archivePath}: ${errorMessage(error)}`);
	}
	const actualSha256 = createHash("sha256").update(archivedBytes).digest("hex");
	if (actualSha256 !== file.record.sha256) {
		throw new PackbatError(`archived file is corrupt: ${file.archivePath} (sha256 mismatch)`);
	}
	try {
		return decompressBytes(archivedBytes);
	} catch (error) {
		throw new PackbatError(`could not read archived file ${file.archivePath}: ${errorMessage(error)}`);
	}
}

function sideBySidePath(target: string, sessionId: string): string {
	// DRAFT copy
	return join(dirname(target), `opencode-restored-${sessionId}.db`);
}

async function restoreDatabaseSnapshot(unit: ArchivedUnit): Promise<RestoreResult> {
	const adapter = getAdapter(unit.harness);
	if (adapter === undefined || adapter.mutationModel !== "db-snapshot") {
		// DRAFT copy
		throw new PackbatError(`archive uses unsupported database snapshot harness ${unit.harness}`);
	}
	const target = adapter.storeRoot(process.env, homedir());
	if ((await liveMtime(target)) !== null) {
		const recoveryPath = sideBySidePath(target, unit.id);
		// DRAFT copy
		throw new PackbatError(
			`restore requires an absent OpenCode database: ${target}\nside-by-side recovery: OPENCODE_DB=${recoveryPath} opencode -s ${unit.id}`,
		);
	}
	const file = unit.files[0];
	if (file === undefined || unit.files.length !== 1 || !isDatabaseSnapshotIndexRecord(file.record)) {
		// DRAFT copy
		throw new PackbatError(`invalid database snapshot archive for ${unit.id}`);
	}
	const bytes = await archivedPayload(file);
	const contentSha256 = createHash("sha256").update(bytes).digest("hex");
	if (contentSha256 !== file.record.contentSha256) {
		// DRAFT copy
		throw new PackbatError(`archived database is corrupt: ${file.archivePath} (content sha256 mismatch)`);
	}
	await mkdir(dirname(target), { recursive: true });
	const temporary = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(temporary, bytes);
		await adapter.validateSnapshot(temporary, unit.id);
		if ((await liveMtime(target)) !== null) {
			const recoveryPath = sideBySidePath(target, unit.id);
			// DRAFT copy
			throw new PackbatError(
				`restore requires an absent OpenCode database: ${target}\nside-by-side recovery: OPENCODE_DB=${recoveryPath} opencode -s ${unit.id}`,
			);
		}
		await Promise.all([rm(`${target}-wal`, { force: true }), rm(`${target}-shm`, { force: true })]);
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		if (error instanceof PackbatError) {
			throw error;
		}
		throw new PackbatError(`could not restore ${target}: ${errorMessage(error)}`);
	}
	return {
		fileCount: 1,
		targetRoot: target,
		resumeHints: adapter.resumeHint({ id: unit.id, targetPath: target }),
	};
}

export async function restoreArchivedUnit(unit: ArchivedUnit, force: boolean): Promise<RestoreResult> {
	if (unit.kind === "db-snapshot") {
		return await restoreDatabaseSnapshot(unit);
	}
	const adapter = getAdapter(unit.harness);
	if (adapter === undefined || adapter.mutationModel === "db-snapshot") {
		throw new PackbatError(`archive uses unsupported harness ${unit.harness}`);
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
			throw new PackbatError(`archive maps more than one file to ${plan.target}`);
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
		throw new PackbatError(
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
