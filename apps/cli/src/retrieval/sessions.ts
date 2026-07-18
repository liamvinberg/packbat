import type { DatabaseSync } from "node:sqlite";
import type { HarnessId } from "../adapters/adapter.js";
import { headOf } from "./range.js";

export interface SessionFilters {
	project: string | null;
	since: string | null;
	harness: HarnessId | null;
	machine: string | null;
	file: string | null;
	command: string | null;
}

export interface SessionSummary {
	key: string;
	harness: HarnessId;
	machine: string;
	startedAt: string | null;
	updatedAt: string | null;
	turns: number;
	projects: string[];
	head: string | null;
}

export interface SessionsResult {
	sessions: SessionSummary[];
	truncated: boolean;
}

interface SessionRow {
	key: string;
	harness: HarnessId;
	machine: string;
	started_at: string | null;
	updated_at: string | null;
	turns: number;
	projects: string;
	head: string | null;
}

function sessionHead(text: string | null): string | null {
	return text === null ? null : headOf(text, 60);
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/gu, "\\$&");
}

export function listSessions(database: DatabaseSync, filters: SessionFilters, limit: number): SessionsResult {
	const conditions: string[] = [];
	const parameters: Array<string | number> = [];
	if (filters.project !== null) {
		conditions.push(
			"EXISTS (SELECT 1 FROM turns project_turn WHERE project_turn.unit = u.key AND project_turn.project = ?)",
		);
		parameters.push(filters.project);
	}
	if (filters.since !== null) {
		conditions.push("u.updated_at >= ?");
		parameters.push(filters.since);
	}
	if (filters.harness !== null) {
		conditions.push("u.harness = ?");
		parameters.push(filters.harness);
	}
	if (filters.machine !== null) {
		conditions.push("u.machine = ?");
		parameters.push(filters.machine);
	}
	if (filters.file !== null) {
		conditions.push(
			"EXISTS (SELECT 1 FROM turns file_turn WHERE file_turn.unit = u.key AND file_turn.files_touched LIKE ('%' || ? || '%') ESCAPE '\\' COLLATE NOCASE)",
		);
		parameters.push(escapeLike(filters.file));
	}
	if (filters.command !== null) {
		conditions.push(
			"EXISTS (SELECT 1 FROM turns command_turn WHERE command_turn.unit = u.key AND command_turn.commands LIKE ('%' || ? || '%') ESCAPE '\\' COLLATE NOCASE)",
		);
		parameters.push(escapeLike(filters.command));
	}
	const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
	const rows = database
		.prepare(`
			SELECT u.key, u.harness, u.machine, u.started_at, u.updated_at,
				(SELECT count(*) FROM turns counted_turn WHERE counted_turn.unit = u.key) AS turns,
				COALESCE((
					SELECT json_group_array(project)
					FROM (
						SELECT DISTINCT project_turn.project AS project
						FROM turns project_turn
						WHERE project_turn.unit = u.key AND project_turn.project IS NOT NULL
						ORDER BY project_turn.project
					)
				), '[]') AS projects,
				(
					SELECT head_turn.text
					FROM turns head_turn
					WHERE head_turn.unit = u.key AND head_turn.role = 'user'
					ORDER BY head_turn.turn
					LIMIT 1
				) AS head
			FROM units u
			${where}
			ORDER BY u.updated_at IS NULL, u.updated_at DESC, u.key ASC
			LIMIT ?
		`)
		.all(...parameters, limit + 1) as unknown as SessionRow[];
	const truncated = rows.length > limit;
	return {
		sessions: rows.slice(0, limit).map((row) => ({
			key: row.key,
			harness: row.harness,
			machine: row.machine,
			startedAt: row.started_at,
			updatedAt: row.updated_at,
			turns: row.turns,
			projects: JSON.parse(row.projects) as string[],
			head: sessionHead(row.head),
		})),
		truncated,
	};
}
