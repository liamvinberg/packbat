import { resolve } from "node:path";
import { HARNESS_IDS, type HarnessId, isHarnessId } from "../adapters/adapter.js";
import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import { withRetrievalLock } from "../core/lock.js";
import {
	assertFts5,
	closeDatabase,
	openAndRefresh,
	rebuildRetrieval,
	type SearchFilters,
	type SearchHit,
	searchDatabase,
} from "../retrieval/database.js";

// DRAFT copy. Usage is pinned byte-for-byte by the retrieval contract.
const USAGE = `Usage: packbat search <query> [--harness <id>] [--machine <name>] [--project <path>] [--since <RFC3339>] [--json]
       packbat search --rebuild [--json]
`;

interface SearchOptions {
	query: string | null;
	harness: HarnessId | null;
	machine: string | null;
	project: string | null;
	since: string | null;
	json: boolean;
	rebuild: boolean;
}

function usageError(message: string): null {
	// DRAFT copy
	process.stderr.write(`packbat search: ${message}\n\n${USAGE}`);
	return null;
}

function optionValue(argv: string[], index: number, option: string): string | null {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		usageError(`${option} requires a value`);
		return null;
	}
	return value;
}

function parseSince(value: string): string | null {
	const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (date === null) return null;
	const year = Number(date[1]);
	const month = Number(date[2]);
	const day = Number(date[3]);
	if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const parsed = new Date(`${value}T00:00:00.000Z`);
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseOptions(argv: string[]): SearchOptions | null {
	// DRAFT copy applies to validation messages passed to usageError below.
	const options: SearchOptions = {
		query: null,
		harness: null,
		machine: null,
		project: null,
		since: null,
		json: false,
		rebuild: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (argument === "--json") {
			if (options.json) return usageError("--json may only be passed once");
			options.json = true;
		} else if (argument === "--rebuild") {
			if (options.rebuild) return usageError("--rebuild may only be passed once");
			options.rebuild = true;
		} else if (argument === "--harness") {
			if (options.harness !== null) return usageError("--harness may only be passed once");
			const value = optionValue(argv, index, argument);
			if (value === null) return null;
			if (!isHarnessId(value)) return usageError(`--harness must be one of ${HARNESS_IDS.join(", ")}`);
			options.harness = value;
			index += 1;
		} else if (argument === "--machine") {
			if (options.machine !== null) return usageError("--machine may only be passed once");
			const value = optionValue(argv, index, argument);
			if (value === null) return null;
			options.machine = value;
			index += 1;
		} else if (argument === "--project") {
			if (options.project !== null) return usageError("--project may only be passed once");
			const value = optionValue(argv, index, argument);
			if (value === null) return null;
			options.project = resolve(value);
			index += 1;
		} else if (argument === "--since") {
			if (options.since !== null) return usageError("--since may only be passed once");
			const value = optionValue(argv, index, argument);
			if (value === null) return null;
			const since = parseSince(value);
			if (since === null) return usageError("--since must be RFC3339 or YYYY-MM-DD");
			options.since = since;
			index += 1;
		} else if (argument.startsWith("-")) {
			return usageError(`unknown option ${argument}`);
		} else if (options.query !== null) {
			return usageError("only one query may be passed");
		} else {
			options.query = argument;
		}
	}
	if (options.rebuild) {
		if (
			options.query !== null ||
			options.harness !== null ||
			options.machine !== null ||
			options.project !== null ||
			options.since !== null
		) {
			return usageError("--rebuild only accepts --json");
		}
	} else if (options.query === null) {
		return usageError("a query is required");
	}
	return options;
}

function printHit(hit: SearchHit): void {
	// DRAFT copy
	process.stdout.write(`${hit.key} · turn ${hit.turn} · ${hit.role}`);
	if (hit.timestamp !== null) process.stdout.write(` · ${hit.timestamp}`);
	process.stdout.write("\n");
	if (hit.project !== null) process.stdout.write(`${hit.project}\n`);
	process.stdout.write(`${hit.snippet}\n`);
	if (hit.filesTouched.length > 0) process.stdout.write(`files: ${hit.filesTouched.join(", ")}\n`);
	if (hit.commands.length > 0) process.stdout.write(`commands: ${hit.commands.join(" | ")}\n`);
	process.stdout.write("\n");
}

export async function runSearch(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) return 1;
	assertFts5();
	const home = resolveHome();
	const config = loadConfig(home);
	const locked = await withRetrievalLock(home.statePath, async () => {
		if (options.rebuild) {
			const report = await rebuildRetrieval(home, config);
			if (options.json) {
				process.stdout.write(`${JSON.stringify({ v: 1, ...report })}\n`);
			} else {
				// DRAFT copy
				process.stdout.write(
					`rebuilt ${report.files} files, ${report.units} units, ${report.turns} turns · ${report.bytes} bytes · ${report.elapsedMs} ms\n`,
				);
			}
			return 0;
		}
		const database = await openAndRefresh(home, config);
		try {
			const filters: SearchFilters = {
				harness: options.harness,
				machine: options.machine,
				project: options.project,
				since: options.since,
			};
			const result = searchDatabase(database, options.query!, filters);
			if (options.json) {
				process.stdout.write(`${JSON.stringify({ v: 1, query: options.query, filters, ...result })}\n`);
			} else {
				for (const hit of result.results) printHit(hit);
			}
			return 0;
		} finally {
			closeDatabase(database);
		}
	});
	if (!locked.acquired) {
		// DRAFT copy
		process.stderr.write("packbat search: retrieval is already running\n");
		return 1;
	}
	return locked.value;
}
