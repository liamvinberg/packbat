import { loadConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { resolveHome } from "../core/home.js";
import { tryRetrievalLock, withRetrievalLock } from "../core/lock.js";
import {
	assertFts5,
	closeDatabase,
	openAndRefresh,
	openStaleRetrieval,
	retrievalDatabasePath,
} from "../retrieval/database.js";
import { queryRetrieval, type RetrievalQueryResult } from "../retrieval/query.js";
import { scanSql } from "../retrieval/sql-scan.js";

// DRAFT copy. Usage is pinned byte-for-byte by the retrieval contract.
const USAGE = "Usage: packbat query <select-sql> [--json]\n";

interface QueryOptions {
	sql: string;
	json: boolean;
	hints: string[];
}

function usageError(message: string): null {
	// DRAFT copy
	process.stderr.write(`packbat query: ${message}\n\n${USAGE}`);
	return null;
}

function parseOptions(argv: string[]): QueryOptions | null {
	let sql: string | null = null;
	let json = false;
	for (const argument of argv) {
		if (argument === "--json") {
			if (json) return usageError("--json may only be passed once");
			json = true;
		} else if (argument.startsWith("-")) {
			return usageError(`unknown option ${argument}`);
		} else if (sql !== null) {
			return usageError("only one SQL statement may be passed");
		} else {
			sql = argument;
		}
	}
	if (sql === null) return usageError("a SELECT is required");
	const scan = scanSql(sql);
	if (!/^\s*(select|with)\b/i.test(scan.sql)) return usageError("query must start with SELECT or WITH");
	if (scan.moreAfterSemicolon) return usageError("only one statement is allowed");
	if (scan.unterminated) {
		// DRAFT copy
		return usageError(
			"a quote opens but never closes, escape a quote inside a string by doubling it, not with a backslash",
		);
	}
	const hints: string[] = [];
	// DRAFT copy
	if (scan.curlyQuote) hints.push("the query contains curly quotes, replace them with straight quotes");
	if (scan.backslashQuote || scan.invalidBackslash) {
		// DRAFT copy
		hints.push("backslash escapes are not SQL, double a quote inside a string and use char(10) for a newline");
	}
	return { sql: scan.sql, json, hints };
}

function plainValue(value: unknown): string {
	if (value === null) return "";
	if (typeof value === "string") {
		return value.replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
	}
	return String(value);
}

function printPlain(result: RetrievalQueryResult): void {
	process.stdout.write(`${result.columns.join("\t")}\n`);
	for (const row of result.rows) {
		process.stdout.write(`${row.map(plainValue).join("\t")}\n`);
	}
	if (result.truncated) {
		// DRAFT copy
		process.stdout.write("capped at 200 rows · add a LIMIT to your query\n");
	}
}

export async function runQuery(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) return 1;
	assertFts5();
	const home = resolveHome();
	const config = loadConfig(home);
	const refreshOnly = async (): Promise<void> => {
		const database = await openAndRefresh(home, config);
		closeDatabase(database);
	};
	const locked = await tryRetrievalLock(home.statePath, refreshOnly);
	if (!locked.acquired) {
		const staleDatabase = openStaleRetrieval(home);
		if (staleDatabase === null) {
			const waited = await withRetrievalLock(home.statePath, refreshOnly);
			if (!waited.acquired) {
				// DRAFT copy
				process.stderr.write("packbat query: the retrieval index is being built, try again in a few minutes\n");
				return 1;
			}
		} else {
			closeDatabase(staleDatabase);
			// DRAFT copy
			process.stderr.write(
				"packbat query: the retrieval index is refreshing, results may be missing the newest sessions\n",
			);
		}
	}
	let result: RetrievalQueryResult;
	try {
		result = queryRetrieval(retrievalDatabasePath(home), options.sql);
	} catch (error) {
		if (error instanceof PackbatError && options.hints.length > 0) {
			throw new PackbatError(`${error.message}\n${options.hints.join("\n")}`);
		}
		throw error;
	}
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ v: 1, ...result })}\n`);
	} else {
		printPlain(result);
	}
	return 0;
}
