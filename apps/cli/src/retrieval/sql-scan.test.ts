import { describe, expect, test } from "vitest";
import { scanSql } from "./sql-scan.js";

const CLEAN = {
	sql: "",
	moreAfterSemicolon: false,
	unterminated: false,
	backslashQuote: false,
	curlyQuote: false,
	invalidBackslash: false,
};

describe("scanSql", () => {
	test.each([
		"SELECT count(*) AS count FROM turns",
		"WITH totals AS (SELECT 1 AS n) SELECT n FROM totals",
		"SELECT 'it''s; fine' FROM turns",
		'SELECT "role", [text], `unit` FROM turns',
		"SELECT text FROM turns -- trailing note",
		"SELECT /* block ; ' note */ 1",
		"SELECT a,\n\tb\nFROM t",
		"SELECT replace(text, char(10), ' ') FROM turns",
	])("returns clean queries byte for byte: %s", (sql) => {
		expect(scanSql(sql)).toEqual({ ...CLEAN, sql });
	});

	test("repairs JSON escaped whitespace outside strings", () => {
		expect(scanSql(String.raw`SELECT a,\nb\tFROM\rt`)).toEqual({ ...CLEAN, sql: "SELECT a,\nb\tFROM\nt" });
		expect(scanSql(String.raw`\nSELECT 1`)).toEqual({ ...CLEAN, sql: "\nSELECT 1" });
		expect(scanSql(String.raw`SELECT a\\nFROM t`)).toEqual({ ...CLEAN, sql: "SELECT a\nFROM t" });
	});

	test("keeps backslash sequences inside strings and block comments", () => {
		const inString = String.raw`SELECT text FROM turns WHERE text LIKE '%\n%'`;
		expect(scanSql(inString)).toEqual({ ...CLEAN, sql: inString });
		const inBlock = String.raw`SELECT /* keep \n here */ 1`;
		expect(scanSql(inBlock)).toEqual({ ...CLEAN, sql: inBlock });
	});

	test("ends a line comment at a repaired newline", () => {
		expect(scanSql(String.raw`SELECT count(*) AS count -- total\nFROM turns`)).toEqual({
			...CLEAN,
			sql: "SELECT count(*) AS count -- total\nFROM turns",
		});
	});

	test("treats semicolons inside strings and comments as content", () => {
		const inString = "SELECT count(*) FROM turns WHERE text LIKE '%;%'";
		expect(scanSql(inString)).toEqual({ ...CLEAN, sql: inString });
		const inComment = "SELECT 1 -- note; still a comment";
		expect(scanSql(inComment)).toEqual({ ...CLEAN, sql: inComment });
	});

	test("strips one statement-final semicolon", () => {
		expect(scanSql("SELECT 1;")).toEqual({ ...CLEAN, sql: "SELECT 1" });
		expect(scanSql("SELECT 1;   ")).toEqual({ ...CLEAN, sql: "SELECT 1   " });
		expect(scanSql("SELECT 1; -- done")).toEqual({ ...CLEAN, sql: "SELECT 1 -- done" });
	});

	test("flags SQL after a statement-final semicolon", () => {
		expect(scanSql("SELECT 1; SELECT 2").moreAfterSemicolon).toBe(true);
		expect(scanSql("SELECT 1;;").moreAfterSemicolon).toBe(true);
		expect(scanSql("SELECT 1; 'text'").moreAfterSemicolon).toBe(true);
	});

	test("flags strings and quoted names that never close", () => {
		expect(scanSql("SELECT 'open").unterminated).toBe(true);
		expect(scanSql('SELECT "open').unterminated).toBe(true);
		expect(scanSql("SELECT [open").unterminated).toBe(true);
		expect(scanSql("SELECT 'closed'").unterminated).toBe(false);
	});

	test("flags curly quotes outside strings only", () => {
		expect(scanSql("SELECT ‘user’ FROM turns").curlyQuote).toBe(true);
		expect(scanSql("SELECT text FROM turns WHERE text LIKE '%don’t%'").curlyQuote).toBe(false);
	});

	test("flags backslash escaped quotes inside strings", () => {
		const scan = scanSql(String.raw`SELECT * FROM turns WHERE text = 'it\'s ok' AND role = 'user'`);
		expect(scan.backslashQuote).toBe(true);
	});

	test("flags backslashes it cannot repair", () => {
		expect(scanSql(String.raw`SELECT \x FROM t`).invalidBackslash).toBe(true);
		expect(scanSql(String.raw`SELECT a\nb FROM t`).invalidBackslash).toBe(false);
	});

	test("normalizes pasted unicode whitespace outside strings", () => {
		expect(scanSql("SELECT\u00a01").sql).toBe("SELECT 1");
		expect(scanSql("\ufeffSELECT\u200b 1").sql).toBe("SELECT 1");
		expect(scanSql("SELECT '\u00a0\u200b'").sql).toBe("SELECT '\u00a0\u200b'");
	});
});
