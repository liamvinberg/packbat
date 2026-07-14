import { expect, test } from "vitest";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

test("--version prints the package version", async () => {
	const home = await makeTempHome();
	const result = await runCli(["--version"], { home });
	expect(result.code).toBe(0);
	expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("no command prints usage and exits 1", async () => {
	const home = await makeTempHome();
	const result = await runCli([], { home });
	expect(result.code).toBe(1);
	expect(result.stdout).toContain("Packbat — every agent session, kept.");
	expect(result.stdout).toContain("Usage: packbat <command>");
});

test("unknown command names itself on stderr and exits 1", async () => {
	const home = await makeTempHome();
	const result = await runCli(["frobnicate"], { home });
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('packbat: unknown command "frobnicate"');
});
