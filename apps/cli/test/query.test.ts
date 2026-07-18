import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { makeRetrievalLayout, type RetrievalLayout, writeArchivedJsonl } from "./helpers/retrieval-fixtures.js";
import { runCli } from "./helpers/run-cli.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const homes: string[] = [];

interface QueryJson {
	v: 1;
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
}

async function layout(): Promise<RetrievalLayout> {
	const value = await makeRetrievalLayout();
	homes.push(value.home);
	return value;
}

function command(layout: RetrievalLayout, sql: string, json = false) {
	return runCli(["query", sql, ...(json ? ["--json"] : [])], { home: layout.home, env: layout.env });
}

async function writeTurns(
	testLayout: RetrievalLayout,
	options: { id?: string; count: number; text?: (index: number) => string },
): Promise<void> {
	const id = options.id ?? FIRST_ID;
	await writeArchivedJsonl({
		layout: testLayout,
		harness: "claude-code",
		unit: id,
		relPath: `-synthetic/${id}.jsonl`,
		lines: Array.from({ length: options.count }, (_, index) => ({
			type: "user",
			message: { role: "user", content: options.text?.(index) ?? `fixture turn ${index}` },
		})),
	});
}

function readUserVersion(path: string): number {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	} finally {
		database.close();
	}
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("packbat query", () => {
	test("runs aggregate and WITH queries in plain and JSON formats", async () => {
		const testLayout = await layout();
		await writeTurns(testLayout, { count: 2 });

		const plain = await command(testLayout, "SELECT count(*) AS count FROM turns");
		expect(plain.code, plain.stderr).toBe(0);
		expect(plain.stdout).toBe("count\n2\n");

		const json = await command(testLayout, "SELECT count(*) AS count FROM turns", true);
		expect(json.code, json.stderr).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({ v: 1, columns: ["count"], rows: [[2]], truncated: false });

		const withQuery = await command(
			testLayout,
			"WITH totals AS (SELECT count(*) AS count FROM turns) SELECT count FROM totals",
		);
		expect(withQuery.code, withQuery.stderr).toBe(0);
		expect(withQuery.stdout).toBe("count\n2\n");

		const trailingSemicolon = await command(testLayout, "SELECT count(*) AS count FROM turns;   ");
		expect(trailingSemicolon.code, trailingSemicolon.stderr).toBe(0);
		expect(trailingSemicolon.stdout).toBe("count\n2\n");

		const empty = await command(testLayout, "SELECT text FROM turns WHERE 0");
		expect(empty.code, empty.stderr).toBe(0);
		expect(empty.stdout).toBe("text\n");
	});

	test("rejects writes and leaves the retrieval database byte-for-byte unchanged", async () => {
		const testLayout = await layout();
		await writeTurns(testLayout, { count: 1 });
		expect((await command(testLayout, "SELECT count(*) FROM turns")).code).toBe(0);
		const databasePath = join(testLayout.packbatHome, "cache", "retrieval.sqlite");
		const before = await readFile(databasePath);
		const beforeVersion = readUserVersion(databasePath);

		for (const sql of [
			"INSERT INTO turns (text) VALUES ('changed')",
			"UPDATE turns SET text = 'changed'",
			"DELETE FROM turns",
			"DROP TABLE turns",
			"PRAGMA user_version = 9",
		]) {
			const result = await command(testLayout, sql);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("query must start with SELECT or WITH");
		}

		const prefixedWrite = await command(
			testLayout,
			"WITH candidate AS (SELECT 1) INSERT INTO turns (text) VALUES ('changed')",
		);
		expect(prefixedWrite.code).toBe(1);
		expect(prefixedWrite.stdout).toBe("");
		expect(prefixedWrite.stderr).toContain("packbat: invalid query:");

		expect(await readFile(databasePath)).toEqual(before);
		expect(readUserVersion(databasePath)).toBe(beforeVersion);
	});

	test("rejects multiple statements and reports SQLite errors", async () => {
		const testLayout = await layout();
		const noSql = await runCli(["query"], { home: testLayout.home, env: testLayout.env });
		expect(noSql.code).toBe(1);
		expect(noSql.stderr).toContain("a SELECT is required");

		const twoArguments = await runCli(["query", "select 1", "select 2"], {
			home: testLayout.home,
			env: testLayout.env,
		});
		expect(twoArguments.code).toBe(1);
		expect(twoArguments.stderr).toContain("only one SQL statement may be passed");

		const multiple = await command(testLayout, "select 1; select 2");
		expect(multiple.code).toBe(1);
		expect(multiple.stderr).toContain("only one statement is allowed");
		expect(multiple.stderr).toContain("Usage: packbat query <select-sql> [--json]\n");

		const invalid = await command(testLayout, "select * from missing_table");
		expect(invalid.code).toBe(1);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain("packbat: invalid query: no such table: missing_table");
	});

	test("repairs pasted queries with JSON escaped whitespace and supports semicolons inside strings", async () => {
		const testLayout = await layout();
		await writeTurns(testLayout, { count: 3, text: (index) => `payload; keep ${index}` });

		const flattened =
			"SELECT unit, turn,\\nsubstr(replace(text, char(10), ' '), 1, 700) AS snippet\\nFROM turns\\nWHERE lower(text) LIKE '%payload%'\\nORDER BY timestamp DESC\\nLIMIT 100";
		const repaired = await command(testLayout, flattened);
		expect(repaired.code, repaired.stderr).toBe(0);
		expect(repaired.stdout.split("\n")[0]).toBe("unit\tturn\tsnippet");
		expect(repaired.stdout).toContain("payload; keep 0");

		const semicolonInString = await command(testLayout, "SELECT count(*) AS count FROM turns WHERE text LIKE '%;%'");
		expect(semicolonInString.code, semicolonInString.stderr).toBe(0);
		expect(semicolonInString.stdout).toBe("count\n3\n");

		const trailingComment = await command(testLayout, "SELECT count(*) AS count FROM turns -- total");
		expect(trailingComment.code, trailingComment.stderr).toBe(0);
		expect(trailingComment.stdout).toBe("count\n3\n");
	});

	test("fails fast on unclosed quotes and hints on paste artifacts SQLite rejects", async () => {
		const testLayout = await layout();
		await writeTurns(testLayout, { count: 1 });

		const escaped = await command(testLayout, "SELECT text FROM turns WHERE text = 'it\\'s ok'");
		expect(escaped.code).toBe(1);
		expect(escaped.stderr).toContain("a quote opens but never closes");

		const curly = await command(testLayout, "SELECT ‘user’ FROM turns");
		expect(curly.code).toBe(1);
		expect(curly.stderr).toContain("packbat: invalid query:");
		expect(curly.stderr).toContain("curly quotes");

		const stray = await command(testLayout, "SELECT p\\u00e5minn FROM turns");
		expect(stray.code).toBe(1);
		expect(stray.stderr).toContain("backslash escapes are not SQL");
	});

	test("caps output at 200 rows in plain and JSON formats", async () => {
		const testLayout = await layout();
		await writeTurns(testLayout, { count: 205 });
		const sql = "SELECT turn FROM turns ORDER BY turn";

		const plain = await command(testLayout, sql);
		expect(plain.code, plain.stderr).toBe(0);
		const lines = plain.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(202);
		expect(lines[0]).toBe("turn");
		expect(lines[1]).toBe("0");
		expect(lines[200]).toBe("199");
		expect(lines[201]).toBe("capped at 200 rows · add a LIMIT to your query");

		const json = JSON.parse((await command(testLayout, sql, true)).stdout) as QueryJson;
		expect(json.columns).toEqual(["turn"]);
		expect(json.rows).toHaveLength(200);
		expect(json.rows.at(-1)).toEqual([199]);
		expect(json.truncated).toBe(true);
	});

	test("refreshes new archives before querying", async () => {
		const testLayout = await layout();
		await writeTurns(testLayout, { count: 1 });
		expect((await command(testLayout, "SELECT count(*) AS count FROM units")).stdout).toBe("count\n1\n");

		await writeTurns(testLayout, { id: SECOND_ID, count: 1 });
		const refreshed = await command(testLayout, "SELECT count(*) AS count FROM units");
		expect(refreshed.code, refreshed.stderr).toBe(0);
		expect(refreshed.stdout).toBe("count\n2\n");
	});

	test("escapes control characters in plain output and preserves them in JSON", async () => {
		const testLayout = await layout();
		const sql =
			"SELECT 'tab' || char(9) || 'line' || char(10) || 'carriage' || char(13) || 'return' AS text, NULL AS empty";

		const plain = await command(testLayout, sql);
		expect(plain.code, plain.stderr).toBe(0);
		expect(plain.stdout).toBe("text\tempty\ntab\\tline\\ncarriage\\rreturn\t\n");

		const json = JSON.parse((await command(testLayout, sql, true)).stdout) as QueryJson;
		expect(json).toEqual({
			v: 1,
			columns: ["text", "empty"],
			rows: [["tab\tline\ncarriage\rreturn", null]],
			truncated: false,
		});
	});
});
