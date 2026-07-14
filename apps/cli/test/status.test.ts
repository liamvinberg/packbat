import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeClaudeStore, makeCodexStore, makeOpenCodeStore, makePiStore } from "./helpers/fixtures.js";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const homes: string[] = [];

interface StatusJson {
	v: 2;
	machine: string;
	archiveRoot: string;
	schedule: { installed: boolean; live: "not-checked"; liveDetail: string };
	lastRun: { ok: boolean; archived: number; unchanged: number; failed: number } | null;
	lastSuccess: { ok: boolean } | null;
	harnesses: Array<{ harness: string; units: number; files: number; storedBytes: number }>;
	offbox: Array<{ status: string; detail: string }>;
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function sweptLayout(): Promise<{
	home: string;
	blotterHome: string;
	archiveRoot: string;
	env: Record<string, string>;
}> {
	const home = await makeTempHome();
	homes.push(home);
	const blotterHome = join(home, "blotter");
	const archiveRoot = join(home, "archive");
	const claudeConfigDir = join(home, "stores", "claude");
	const env = {
		BLOTTER_HOME: blotterHome,
		CLAUDE_CONFIG_DIR: claudeConfigDir,
		CODEX_HOME: join(home, "stores", "codex"),
		OPENCODE_DB: join(home, "stores", "opencode", "opencode.db"),
		PI_CODING_AGENT_SESSION_DIR: join(home, "stores", "pi"),
	};
	await makeClaudeStore(join(claudeConfigDir, "projects"));
	await makeCodexStore(env.CODEX_HOME);
	await makePiStore(env.PI_CODING_AGENT_SESSION_DIR);
	const openCode = await makeOpenCodeStore(env.OPENCODE_DB);
	const initialized = await runCli(
		["init", "--yes", "--archive-root", archiveRoot, "--offbox", "skip", "--no-activate"],
		{ home, env },
	);
	openCode.database.close();
	expect(initialized.code).toBe(0);
	return { home, blotterHome, archiveRoot, env };
}

describe("blotter status", () => {
	test("prints the one-screen summary without probing the live scheduler", async () => {
		const layout = await sweptLayout();

		const result = await runCli(["status"], { home: layout.home, env: { ...layout.env, PATH: "" } });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("machine:");
		expect(result.stdout).toContain(`archive: ${layout.archiveRoot}`);
		expect(result.stdout).toContain("schedule:");
		expect(result.stdout).toContain("live state not checked");
		expect(result.stdout).toContain("last run:");
		expect(result.stdout).toContain("archived 6, unchanged 0, failed 0");
		expect(result.stdout).toContain("last success:");
		expect(result.stdout).toMatch(/claude-code: 1 unit · 3 files · \d+(?:\.\d+)? (?:B|KiB)/);
		expect(result.stdout).toMatch(/codex: 1 unit · 1 file · \d+(?:\.\d+)? (?:B|KiB)/);
		expect(result.stdout).toMatch(/pi: 1 unit · 1 file · \d+(?:\.\d+)? (?:B|KiB)/);
		expect(result.stdout).toMatch(/opencode: 1 unit · 1 file · \d+(?:\.\d+)? (?:B|KiB)/);
		expect(result.stdout).toContain("offbox: off-box skipped on");
	});

	test("reports index tallies as stable versioned JSON", async () => {
		const layout = await sweptLayout();

		const result = await runCli(["status", "--json"], {
			home: layout.home,
			env: { ...layout.env, PATH: "" },
		});

		const report = JSON.parse(result.stdout) as StatusJson;
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(report).toMatchObject({
			v: 2,
			archiveRoot: layout.archiveRoot,
			schedule: { installed: true, live: "not-checked", liveDetail: expect.stringContaining("doctor") },
			lastRun: { ok: true, archived: 6, unchanged: 0, failed: 0 },
			lastSuccess: { ok: true },
			offbox: [{ status: "info", detail: expect.stringContaining("skipped") }],
		});
		expect(report.harnesses).toEqual([
			{ harness: "claude-code", units: 1, files: 3, storedBytes: expect.any(Number) },
			{ harness: "codex", units: 1, files: 1, storedBytes: expect.any(Number) },
			{ harness: "pi", units: 1, files: 1, storedBytes: expect.any(Number) },
			{ harness: "opencode", units: 1, files: 1, storedBytes: expect.any(Number) },
		]);
		for (const tally of report.harnesses) {
			expect(tally.storedBytes).toBeGreaterThan(0);
		}
	});

	test("treats missing config and unsupported options as operational errors", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const missing = await runCli(["status"], { home, env: { BLOTTER_HOME: join(home, "blotter") } });
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toContain("blotter init");

		const invalid = await runCli(["status", "--wat"], { home });
		expect(invalid.code).toBe(1);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain("only --json is accepted");
		expect(invalid.stderr).toContain("Usage: blotter status [--json]");
	});
});
