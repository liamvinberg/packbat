export const SHOW_TEXT_BUDGET = 30_000;
export const OUTLINE_TURN_BUDGET = 250;

export interface RequestedTurnRange {
	from: number;
	to: number | null;
}

export interface RenderedTurnRange {
	from: number | null;
	to: number | null;
}

export interface TurnCursor {
	from: number;
	to: number;
}

export interface CappedTurns<T> {
	turns: T[];
	range: RenderedTurnRange;
	truncated: boolean;
	next: TurnCursor | null;
}

export class TurnRangeError extends Error {
	override name = "TurnRangeError";
}

// DRAFT copy
const INVALID_RANGE = "--turns must be n, a:b, a:, or :b with non-negative ordinals and a <= b";

function ordinal(value: string): number {
	if (!/^\d+$/.test(value)) throw new TurnRangeError(INVALID_RANGE);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new TurnRangeError(INVALID_RANGE);
	return parsed;
}

export function parseTurnRange(value: string): RequestedTurnRange {
	if (!value.includes(":")) {
		const turn = ordinal(value);
		return { from: turn, to: turn };
	}
	const match = /^(\d*):(\d*)$/.exec(value);
	if (match === null || (match[1] === "" && match[2] === "")) throw new TurnRangeError(INVALID_RANGE);
	const from = match[1] === "" ? 0 : ordinal(match[1]!);
	const to = match[2] === "" ? null : ordinal(match[2]!);
	if (to !== null && from > to) throw new TurnRangeError(INVALID_RANGE);
	return { from, to };
}

export function selectTurnRange<T extends { turn: number }>(
	turns: readonly T[],
	requested: RequestedTurnRange | null,
): { turns: T[]; range: RenderedTurnRange } {
	if (turns.length === 0) {
		if (requested !== null) {
			// DRAFT copy
			throw new TurnRangeError("--turns cannot select from an archived unit with no turns");
		}
		return { turns: [], range: { from: null, to: null } };
	}
	const lastOrdinal = turns.at(-1)!.turn;
	const from = requested?.from ?? 0;
	if (from > lastOrdinal) {
		// DRAFT copy
		throw new TurnRangeError(`--turns starts at ${from}, but the last turn is ${lastOrdinal}`);
	}
	const to = Math.min(requested?.to ?? lastOrdinal, lastOrdinal);
	return {
		turns: turns.filter((turn) => turn.turn >= from && turn.turn <= to),
		range: { from, to },
	};
}

function capAt<T extends { turn: number }>(
	selected: { turns: T[]; range: RenderedTurnRange },
	count: number,
): CappedTurns<T> {
	if (selected.turns.length <= count) return { ...selected, truncated: false, next: null };
	const turns = selected.turns.slice(0, count);
	const lastRendered = turns.at(-1)!.turn;
	return {
		turns,
		range: { from: turns[0]!.turn, to: lastRendered },
		truncated: true,
		next: { from: lastRendered + 1, to: selected.range.to! },
	};
}

export function capTurnsByText<T extends { turn: number; text: string }>(
	selected: { turns: T[]; range: RenderedTurnRange },
	all: boolean,
): CappedTurns<T> {
	if (all || selected.turns.length === 0) return { ...selected, truncated: false, next: null };
	let chars = 0;
	let renderedCount = selected.turns.length;
	for (const [index, turn] of selected.turns.entries()) {
		chars += turn.text.length;
		if (chars > SHOW_TEXT_BUDGET) {
			renderedCount = index + 1;
			break;
		}
	}
	return capAt(selected, renderedCount);
}

export function capTurnsByCount<T extends { turn: number }>(selected: {
	turns: T[];
	range: RenderedTurnRange;
}): CappedTurns<T> {
	return capAt(selected, OUTLINE_TURN_BUDGET);
}

export function headOf(text: string, points: number): string {
	return Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, points).join("");
}
