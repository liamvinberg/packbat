import { PackbatError } from "../core/errors.js";
import { getReader } from "../readers/registry.js";
import type { ArchivedRetrievalUnit, ReadUnitResult } from "./types.js";

export interface ShowResult {
	v: 1;
	unit: {
		key: string;
		id: string;
		harness: ArchivedRetrievalUnit["harness"];
		machine: string;
		projects: string[];
		startedAt: string | null;
		updatedAt: string | null;
	};
	turns: Array<{
		turn: number;
		timestamp: string | null;
		project: string | null;
		role: "user" | "assistant" | "tool" | "summary";
		text: string;
		filesTouched: string[];
		commands: string[];
	}>;
	warnings: Array<{
		code: string;
		unit: string;
		source: string;
		line: number | null;
		detail: string;
	}>;
}

export function resolveShowUnit(units: readonly ArchivedRetrievalUnit[], value: string): ArchivedRetrievalUnit {
	const exact = units.find((unit) => unit.key === value);
	if (exact !== undefined) {
		return exact;
	}
	const matches = units.filter((unit) => unit.id.startsWith(value));
	if (matches.length === 0) {
		// DRAFT copy
		throw new PackbatError(`no archived unit matches "${value}"`);
	}
	if (matches.length > 1) {
		// DRAFT copy
		throw new PackbatError(
			`archive unit "${value}" is ambiguous:\n${matches.map((unit) => `  ${unit.key}`).join("\n")}`,
		);
	}
	return matches[0]!;
}

function assertServeable(unit: ArchivedRetrievalUnit, result: ReadUnitResult): void {
	const searchablePaths = new Set(
		unit.files.filter((file) => file.path.endsWith(".jsonl.zst")).map((file) => file.path),
	);
	const failed = result.files.filter(
		(file) => searchablePaths.has(file.path) && (file.status === "unsupported" || file.status === "corrupt"),
	);
	if (failed.length !== searchablePaths.size) {
		return;
	}
	const lines = failed.map((file) => {
		const codes = result.issues
			.filter((issue) => issue.sourcePath === file.path)
			.map((issue) => issue.code)
			.filter((code, index, all) => all.indexOf(code) === index);
		return `  ${file.path}: ${codes.join(", ") || file.status}`;
	});
	// DRAFT copy
	throw new PackbatError(`archived unit cannot be read:\n${lines.join("\n")}`);
}

export async function readShowUnit(unit: ArchivedRetrievalUnit): Promise<ShowResult> {
	const result = await getReader(unit.harness).read(unit);
	assertServeable(unit, result);
	const projects = [...new Set(result.turns.flatMap((turn) => (turn.project === null ? [] : [turn.project])))].sort();
	const timestamps = result.turns
		.flatMap((turn) => (turn.timestamp === null ? [] : [turn.timestamp]))
		.sort((left, right) => left.localeCompare(right));
	return {
		v: 1,
		unit: {
			key: unit.key,
			id: unit.id,
			harness: unit.harness,
			machine: unit.machine,
			projects,
			startedAt: timestamps[0] ?? null,
			updatedAt: timestamps.at(-1) ?? null,
		},
		turns: result.turns.map((turn) => ({
			turn: turn.turn,
			timestamp: turn.timestamp,
			project: turn.project,
			role: turn.role,
			text: turn.text,
			filesTouched: turn.filesTouched,
			commands: turn.commands,
		})),
		warnings: result.issues.map((issue) => ({
			code: issue.code,
			unit: unit.key,
			source: issue.sourcePath,
			line: issue.sourceLine,
			detail: issue.detail,
		})),
	};
}
