import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HarnessId } from "../adapters/adapter.js";
import type { PackbatConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { isEnoent } from "../core/fs.js";
import type { PackbatHome } from "../core/home.js";
import { getReader } from "../readers/registry.js";
import { readArchiveCatalog } from "./catalog.js";
import type { ArchivedRetrievalUnit, ReadTurn } from "./types.js";

const SCHEMA_VERSION = 1;

function newDatabase(path: string): DatabaseSync {
	const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	return new sqlite.DatabaseSync(path);
}

const SCHEMA = `
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

CREATE TABLE archive_files (
  path              TEXT PRIMARY KEY,
  machine           TEXT NOT NULL,
  harness           TEXT NOT NULL,
  unit              TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('main', 'sidecar')),
  stored_size       INTEGER NOT NULL,
  stored_mtime_ms   REAL NOT NULL,
  archive_sha256    TEXT,
  reader_version    INTEGER NOT NULL,
  parse_status      TEXT NOT NULL CHECK (parse_status IN ('ok', 'partial', 'unsupported', 'corrupt')),
  indexed_at        TEXT NOT NULL
) STRICT;

CREATE TABLE units (
  key               TEXT PRIMARY KEY,
  machine           TEXT NOT NULL,
  harness           TEXT NOT NULL,
  id                TEXT NOT NULL,
  started_at        TEXT,
  updated_at        TEXT,
  UNIQUE (machine, harness, id)
) STRICT;

CREATE TABLE turns (
  id                INTEGER PRIMARY KEY,
  unit              TEXT NOT NULL REFERENCES units(key) ON DELETE CASCADE,
  turn              INTEGER NOT NULL,
  source_path       TEXT NOT NULL REFERENCES archive_files(path) ON DELETE CASCADE,
  source_line       INTEGER NOT NULL,
  timestamp         TEXT,
  project           TEXT,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'summary')),
  text              TEXT NOT NULL,
  files_touched     TEXT NOT NULL,
  commands          TEXT NOT NULL,
  UNIQUE (unit, turn)
) STRICT;

CREATE TABLE parse_issues (
  id                INTEGER PRIMARY KEY,
  source_path       TEXT NOT NULL REFERENCES archive_files(path) ON DELETE CASCADE,
  source_line       INTEGER,
  code              TEXT NOT NULL,
  detail            TEXT NOT NULL
) STRICT;

CREATE INDEX turns_filter
  ON turns (project, timestamp, unit, turn);

CREATE INDEX units_filter
  ON units (harness, machine, id);

CREATE VIRTUAL TABLE turns_fts USING fts5(
  unit UNINDEXED,
  turn UNINDEXED,
  role,
  text,
  files_touched,
  commands,
  content = 'turns',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, unit, turn, role, text, files_touched, commands)
  VALUES (new.id, new.unit, new.turn, new.role, new.text, new.files_touched, new.commands);
END;

CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, unit, turn, role, text, files_touched, commands)
  VALUES ('delete', old.id, old.unit, old.turn, old.role, old.text, old.files_touched, old.commands);
END;

CREATE TRIGGER turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, unit, turn, role, text, files_touched, commands)
  VALUES ('delete', old.id, old.unit, old.turn, old.role, old.text, old.files_touched, old.commands);
  INSERT INTO turns_fts(rowid, unit, turn, role, text, files_touched, commands)
  VALUES (new.id, new.unit, new.turn, new.role, new.text, new.files_touched, new.commands);
END;
`;

interface CachedFile {
	path: string;
	machine: string;
	harness: HarnessId;
	unit: string;
	role: "main" | "sidecar";
	stored_size: number;
	stored_mtime_ms: number;
	archive_sha256: string | null;
	reader_version: number;
}

export interface RetrievalWarning {
	code: string;
	unit: string;
	source: string;
	line: number | null;
	detail: string;
}

export interface RebuildReport {
	rebuilt: true;
	files: number;
	units: number;
	turns: number;
	bytes: number;
	elapsedMs: number;
	warnings: RetrievalWarning[];
}

export interface SearchFilters {
	harness: HarnessId | null;
	machine: string | null;
	project: string | null;
	since: string | null;
	role: "user" | "assistant" | "tool" | "summary" | "all" | null;
}

export interface SearchHit {
	key: string;
	unit: string;
	harness: HarnessId;
	machine: string;
	project: string | null;
	turn: number;
	timestamp: string | null;
	role: "user" | "assistant" | "tool" | "summary";
	snippet: string;
	filesTouched: string[];
	commands: string[];
}

export interface SearchResult {
	results: SearchHit[];
	truncated: boolean;
	excluded: { tool: number; summary: number } | null;
	warnings: RetrievalWarning[];
}

interface HitRow {
	key: string;
	unit: string;
	harness: HarnessId;
	machine: string;
	project: string | null;
	turn: number;
	timestamp: string | null;
	role: SearchHit["role"];
	text: string;
	files_touched: string;
	commands: string;
}

export function retrievalDatabasePath(home: PackbatHome): string {
	return join(home.cachePath, "retrieval.sqlite");
}

export function assertFts5(): void {
	const database = newDatabase(":memory:");
	try {
		const options = database.prepare("PRAGMA compile_options").all() as Array<Record<string, unknown>>;
		if (!options.some((row) => Object.values(row).includes("ENABLE_FTS5"))) {
			// DRAFT copy
			throw new PackbatError(
				"retrieval requires SQLite FTS5; use the official Node >=22.16 build or a Node build compiled with ENABLE_FTS5",
			);
		}
	} finally {
		database.close();
	}
}

async function prepareDirectory(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
}

function initialize(path: string): DatabaseSync {
	const database = newDatabase(path);
	database.exec(SCHEMA);
	return database;
}

async function createFreshAt(path: string): Promise<DatabaseSync> {
	await prepareDirectory(path);
	const database = initialize(path);
	await chmod(path, 0o600);
	return database;
}

async function openCurrent(path: string): Promise<DatabaseSync | null> {
	try {
		await stat(path);
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
	const database = newDatabase(path);
	try {
		const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version !== SCHEMA_VERSION) {
			database.close();
			return null;
		}
		database.exec("PRAGMA foreign_keys = ON");
		return database;
	} catch {
		database.close();
		return null;
	}
}

function timestampBounds(turns: readonly ReadTurn[]): { startedAt: string | null; updatedAt: string | null } {
	const values = turns.flatMap((turn) => (turn.timestamp === null ? [] : [turn.timestamp])).sort();
	return { startedAt: values[0] ?? null, updatedAt: values.at(-1) ?? null };
}

async function replaceUnitAsync(database: DatabaseSync, unit: ArchivedRetrievalUnit): Promise<void> {
	const reader = getReader(unit.harness);
	const result = await reader.read(unit);
	const statuses = new Map(result.files.map((file) => [file.path, file.status]));
	const bounds = timestampBounds(result.turns);
	const indexedAt = new Date().toISOString();
	database.exec("BEGIN IMMEDIATE");
	try {
		database.prepare("DELETE FROM units WHERE key = ?").run(unit.key);
		database
			.prepare("DELETE FROM archive_files WHERE machine = ? AND harness = ? AND unit = ?")
			.run(unit.machine, unit.harness, unit.id);
		const insertFile = database.prepare(`
			INSERT INTO archive_files (
				path, machine, harness, unit, role, stored_size, stored_mtime_ms, archive_sha256,
				reader_version, parse_status, indexed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const file of unit.files) {
			insertFile.run(
				file.path,
				file.machine,
				file.harness,
				file.unit,
				file.role,
				file.storedSize,
				file.storedMtimeMs,
				file.archiveSha256,
				reader.version,
				statuses.get(file.path) ?? "corrupt",
				indexedAt,
			);
		}
		database
			.prepare("INSERT INTO units (key, machine, harness, id, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(unit.key, unit.machine, unit.harness, unit.id, bounds.startedAt, bounds.updatedAt);
		const insertTurn = database.prepare(`
			INSERT INTO turns (
				unit, turn, source_path, source_line, timestamp, project, role, text, files_touched, commands
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const turn of result.turns) {
			insertTurn.run(
				unit.key,
				turn.turn,
				turn.sourcePath,
				turn.sourceLine,
				turn.timestamp,
				turn.project,
				turn.role,
				turn.text,
				JSON.stringify(turn.filesTouched),
				JSON.stringify(turn.commands),
			);
		}
		const insertIssue = database.prepare(
			"INSERT INTO parse_issues (source_path, source_line, code, detail) VALUES (?, ?, ?, ?)",
		);
		for (const issue of result.issues) {
			if (statuses.has(issue.sourcePath)) {
				insertIssue.run(issue.sourcePath, issue.sourceLine, issue.code, issue.detail);
			}
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function cachedFiles(database: DatabaseSync): CachedFile[] {
	return database
		.prepare(
			"SELECT path, machine, harness, unit, role, stored_size, stored_mtime_ms, archive_sha256, reader_version FROM archive_files",
		)
		.all() as unknown as CachedFile[];
}

function isChanged(file: ArchivedRetrievalUnit["files"][number], cached: CachedFile | undefined): boolean {
	return (
		cached === undefined ||
		cached.machine !== file.machine ||
		cached.harness !== file.harness ||
		cached.unit !== file.unit ||
		cached.role !== file.role ||
		cached.stored_size !== file.storedSize ||
		cached.stored_mtime_ms !== file.storedMtimeMs ||
		cached.archive_sha256 !== file.archiveSha256 ||
		cached.reader_version !== getReader(file.harness).version
	);
}

async function refresh(database: DatabaseSync, config: PackbatConfig, hashFiles = false): Promise<void> {
	const units = await readArchiveCatalog(config, { hashFiles });
	const byKey = new Map(units.map((unit) => [unit.key, unit]));
	const currentFiles = new Map(units.flatMap((unit) => unit.files.map((file) => [file.path, file] as const)));
	const cached = cachedFiles(database);
	const cachedByPath = new Map(cached.map((file) => [file.path, file]));
	const changedKeys = new Set<string>();
	for (const unit of units) {
		if (unit.files.some((file) => isChanged(file, cachedByPath.get(file.path)))) {
			changedKeys.add(unit.key);
		}
	}
	for (const old of cached) {
		if (!currentFiles.has(old.path)) {
			changedKeys.add(`${old.machine}/${old.harness}/${old.unit}`);
		}
	}
	for (const key of [...changedKeys].sort()) {
		const unit = byKey.get(key);
		if (unit !== undefined) {
			await replaceUnitAsync(database, unit);
		} else {
			database.exec("BEGIN IMMEDIATE");
			try {
				database.prepare("DELETE FROM units WHERE key = ?").run(key);
				const [machine, harness, ...idParts] = key.split("/");
				database
					.prepare("DELETE FROM archive_files WHERE machine = ? AND harness = ? AND unit = ?")
					.run(machine!, harness!, idParts.join("/"));
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		}
	}
}

function warnings(database: DatabaseSync): RetrievalWarning[] {
	const rows = database
		.prepare(`
			SELECT p.code, u.key AS unit, p.source_path AS source, p.source_line AS line, p.detail,
				f.harness, f.reader_version AS readerVersion
			FROM parse_issues p
			JOIN archive_files f ON f.path = p.source_path
			JOIN units u ON u.machine = f.machine AND u.harness = f.harness AND u.id = f.unit
			ORDER BY u.key, p.source_path, p.source_line, p.id
		`)
		.all() as unknown as Array<RetrievalWarning & { harness: string; readerVersion: number }>;
	const unknowns = new Set<string>();
	return rows.flatMap((row) => {
		if (row.code === "unknown-record") {
			const key = `${row.harness}\0${row.readerVersion}\0${row.detail}`;
			if (unknowns.has(key)) return [];
			unknowns.add(key);
		}
		return [{ code: row.code, unit: row.unit, source: row.source, line: row.line, detail: row.detail }];
	});
}

async function buildFresh(path: string, config: PackbatConfig): Promise<DatabaseSync> {
	const database = await createFreshAt(path);
	try {
		await refresh(database, config, true);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

export async function openAndRefresh(home: PackbatHome, config: PackbatConfig): Promise<DatabaseSync> {
	const path = retrievalDatabasePath(home);
	await prepareDirectory(path);
	let database = await openCurrent(path);
	if (database === null) {
		const report = await rebuildRetrieval(home, config);
		void report;
		database = newDatabase(path);
		database.exec("PRAGMA foreign_keys = ON");
		return database;
	}
	await refresh(database, config);
	return database;
}

export async function rebuildRetrieval(home: PackbatHome, config: PackbatConfig): Promise<RebuildReport> {
	const started = performance.now();
	const target = retrievalDatabasePath(home);
	await prepareDirectory(target);
	const temporary = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
	let database: DatabaseSync | null = null;
	try {
		database = await buildFresh(temporary, config);
		const counts = database
			.prepare(
				"SELECT (SELECT count(*) FROM archive_files) AS files, (SELECT count(*) FROM units) AS units, (SELECT count(*) FROM turns) AS turns",
			)
			.get() as { files: number; units: number; turns: number };
		const foundWarnings = warnings(database);
		database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		database.close();
		database = null;
		await chmod(temporary, 0o600);
		await rename(temporary, target);
		const bytes = (await stat(target)).size;
		return {
			rebuilt: true,
			files: counts.files,
			units: counts.units,
			turns: counts.turns,
			bytes,
			elapsedMs: Math.round(performance.now() - started),
			warnings: foundWarnings,
		};
	} catch (error) {
		database?.close();
		await rm(temporary, { force: true });
		throw error;
	}
}

function queryTerms(query: string): string[] {
	return [...query.matchAll(/[\p{L}\p{N}_-]+/gu)]
		.map((match) => match[0])
		.filter((term) => !["AND", "OR", "NOT", "NEAR", "role", "text", "files_touched", "commands"].includes(term));
}

function snippet(text: string, query: string): string {
	const points = Array.from(text);
	if (points.length <= 320) {
		return text;
	}
	const lower = text.toLocaleLowerCase();
	const match = queryTerms(query)
		.map((term) => lower.indexOf(term.toLocaleLowerCase()))
		.find((index) => index >= 0);
	if (match === undefined) {
		return `${points.slice(0, 319).join("")}…`;
	}
	const pointIndex = Array.from(text.slice(0, match)).length;
	let start = Math.max(0, pointIndex - 159);
	let end = Math.min(points.length, start + 320);
	start = Math.max(0, end - 320);
	const leading = start > 0;
	const trailing = end < points.length;
	const budget = 320 - (leading ? 1 : 0) - (trailing ? 1 : 0);
	end = Math.min(points.length, start + budget);
	return `${leading ? "…" : ""}${points.slice(start, end).join("")}${end < points.length ? "…" : ""}`;
}

export function searchDatabase(
	database: DatabaseSync,
	query: string,
	filters: SearchFilters,
	limit: number,
): SearchResult {
	const conditions = ["turns_fts MATCH ?"];
	const parameters: Array<string> = [query];
	if (filters.harness !== null) {
		conditions.push("u.harness = ?");
		parameters.push(filters.harness);
	}
	if (filters.machine !== null) {
		conditions.push("u.machine = ?");
		parameters.push(filters.machine);
	}
	if (filters.project !== null) {
		conditions.push("t.project = ?");
		parameters.push(filters.project);
	}
	if (filters.since !== null) {
		conditions.push("t.timestamp IS NOT NULL AND t.timestamp >= ?");
		parameters.push(filters.since);
	}
	const hitConditions = [...conditions];
	const hitParameters = [...parameters];
	if (filters.role === null) {
		hitConditions.push("t.role IN ('user', 'assistant')");
	} else if (filters.role !== "all") {
		hitConditions.push("t.role = ?");
		hitParameters.push(filters.role);
	}
	let rows: HitRow[];
	let excluded: SearchResult["excluded"] = null;
	try {
		rows = database
			.prepare(`
				SELECT u.key, u.id AS unit, u.harness, u.machine, t.project, t.turn, t.timestamp,
					t.role, t.text, t.files_touched, t.commands
				FROM turns_fts
				JOIN turns t ON t.id = turns_fts.rowid
				JOIN units u ON u.key = t.unit
				WHERE ${hitConditions.join(" AND ")}
				ORDER BY bm25(turns_fts), t.timestamp DESC, u.key ASC, t.turn ASC
				LIMIT ? + 1
			`)
			.all(...hitParameters, limit) as unknown as HitRow[];
		if (filters.role === null) {
			const counts = database
				.prepare(`
					SELECT t.role, count(*) AS count
					FROM turns_fts
					JOIN turns t ON t.id = turns_fts.rowid
					JOIN units u ON u.key = t.unit
					WHERE ${conditions.join(" AND ")} AND t.role IN ('tool', 'summary')
					GROUP BY t.role
				`)
				.all(...parameters) as unknown as Array<{ role: "tool" | "summary"; count: number }>;
			excluded = { tool: 0, summary: 0 };
			for (const count of counts) excluded[count.role] = count.count;
		}
	} catch (error) {
		// DRAFT copy
		throw new PackbatError(`invalid search query: ${error instanceof Error ? error.message : String(error)}`);
	}
	const truncated = rows.length > limit;
	return {
		results: rows.slice(0, limit).map((row) => ({
			key: row.key,
			unit: row.unit,
			harness: row.harness,
			machine: row.machine,
			project: row.project,
			turn: row.turn,
			timestamp: row.timestamp,
			role: row.role,
			snippet: snippet(row.text, query),
			filesTouched: JSON.parse(row.files_touched) as string[],
			commands: JSON.parse(row.commands) as string[],
		})),
		truncated,
		excluded,
		warnings: warnings(database),
	};
}

export function closeDatabase(database: DatabaseSync): void {
	database.close();
}
