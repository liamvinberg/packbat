import { PackbatError } from "../core/errors.js";
import { getReader } from "../readers/registry.js";
import {
	capTurnsByCount,
	capTurnsByText,
	headOf,
	type RenderedTurnRange,
	type RequestedTurnRange,
	selectTurnRange,
	type TurnCursor,
} from "./range.js";
import type { ArchivedRetrievalUnit, ReadRole, ReadUnitResult } from "./types.js";

export interface ShowUnit {
	key: string;
	id: string;
	harness: ArchivedRetrievalUnit["harness"];
	machine: string;
	projects: string[];
	startedAt: string | null;
	updatedAt: string | null;
}

export interface ShowWarning {
	code: string;
	unit: string;
	source: string;
	line: number | null;
	detail: string;
}

export interface ShowResult {
	v: 1;
	unit: ShowUnit;
	turns: Array<{
		turn: number;
		timestamp: string | null;
		project: string | null;
		role: ReadRole;
		text: string;
		filesTouched: string[];
		commands: string[];
	}>;
	range: RenderedTurnRange;
	truncated: boolean;
	next: TurnCursor | null;
	warnings: ShowWarning[];
}

export interface OutlineResult {
	v: 1;
	unit: ShowUnit;
	turns: Array<{
		turn: number;
		role: ReadRole;
		timestamp: string | null;
		chars: number;
		head: string;
	}>;
	range: RenderedTurnRange;
	truncated: boolean;
	next: TurnCursor | null;
	warnings: ShowWarning[];
}

export interface OutlineReadResult {
	result: OutlineResult;
	totalTurns: number;
	totalChars: number;
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

function unitSummary(unit: ArchivedRetrievalUnit, result: ReadUnitResult): ShowUnit {
	const projects = [...new Set(result.turns.flatMap((turn) => (turn.project === null ? [] : [turn.project])))].sort();
	const timestamps = result.turns
		.flatMap((turn) => (turn.timestamp === null ? [] : [turn.timestamp]))
		.sort((left, right) => left.localeCompare(right));
	return {
		key: unit.key,
		id: unit.id,
		harness: unit.harness,
		machine: unit.machine,
		projects,
		startedAt: timestamps[0] ?? null,
		updatedAt: timestamps.at(-1) ?? null,
	};
}

function warnings(unit: ArchivedRetrievalUnit, result: ReadUnitResult): ShowWarning[] {
	return result.issues.map((issue) => ({
		code: issue.code,
		unit: unit.key,
		source: issue.sourcePath,
		line: issue.sourceLine,
		detail: issue.detail,
	}));
}

export async function readShowUnit(
	unit: ArchivedRetrievalUnit,
	requestedRange: RequestedTurnRange | null = null,
	all = false,
): Promise<ShowResult> {
	const result = await getReader(unit.harness).read(unit);
	assertServeable(unit, result);
	const selected = capTurnsByText(selectTurnRange(result.turns, requestedRange), all);
	return {
		v: 1,
		unit: unitSummary(unit, result),
		turns: selected.turns.map((turn) => ({
			turn: turn.turn,
			timestamp: turn.timestamp,
			project: turn.project,
			role: turn.role,
			text: turn.text,
			filesTouched: turn.filesTouched,
			commands: turn.commands,
		})),
		range: selected.range,
		truncated: selected.truncated,
		next: selected.next,
		warnings: warnings(unit, result),
	};
}

export async function readOutlineUnit(
	unit: ArchivedRetrievalUnit,
	requestedRange: RequestedTurnRange | null = null,
): Promise<OutlineReadResult> {
	const read = await getReader(unit.harness).read(unit);
	assertServeable(unit, read);
	const selected = capTurnsByCount(selectTurnRange(read.turns, requestedRange));
	return {
		result: {
			v: 1,
			unit: unitSummary(unit, read),
			turns: selected.turns.map((turn) => ({
				turn: turn.turn,
				role: turn.role,
				timestamp: turn.timestamp,
				chars: turn.text.length,
				head: headOf(turn.text, 80),
			})),
			range: selected.range,
			truncated: selected.truncated,
			next: selected.next,
			warnings: warnings(unit, read),
		},
		totalTurns: read.turns.length,
		totalChars: read.turns.reduce((sum, turn) => sum + turn.text.length, 0),
	};
}
