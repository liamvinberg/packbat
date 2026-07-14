import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	makeClaudeStore,
	makeCodexStore,
	makeGeminiStore,
	makeOpenCodeStore,
	makePiStore,
} from "./helpers/fixtures.js";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const homes: string[] = [];

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("packbat init", () => {
	test("uses PACKBAT_HOME", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, "custom-packbat-home");
		const result = await runCli(["init", "--yes", "--offbox", "skip", "--no-activate"], {
			home,
			env: { PACKBAT_HOME: packbatHome },
		});

		expect(result.code).toBe(0);
		expect(await stat(join(packbatHome, "config.json"))).toBeDefined();
	});

	test("ignores the former home override when it is used alone", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const ignoredFormerHome = join(home, "ignored-former-home");
		const formerHomeKey = ["BLOT", "TER_HOME"].join("");
		const result = await runCli(["init", "--yes", "--offbox", "skip", "--no-activate"], {
			home,
			env: { [formerHomeKey]: ignoredFormerHome },
		});

		expect(result.code).toBe(0);
		expect(await stat(join(home, ".packbat", "config.json"))).toBeDefined();
		await expect(stat(ignoredFormerHome)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("defaults to ~/.packbat", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const result = await runCli(["init", "--yes", "--offbox", "skip", "--no-activate"], { home });

		expect(result.code).toBe(0);
		expect(await stat(join(home, ".packbat", "config.json"))).toBeDefined();
		await expect(stat(join(home, `.${["blot", "ter"].join("")}`))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("sets up a detected machine and runs its first sweep", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, "packbat");
		const archiveRoot = join(home, "custom-archive");
		const claudeConfigDir = join(home, "stores", "claude");
		const claudeRoot = join(claudeConfigDir, "projects");
		const codexRoot = join(home, "stores", "codex");
		const geminiHome = join(home, "stores", "gemini");
		const geminiRoot = join(geminiHome, ".gemini", "tmp");
		const piRoot = join(home, "stores", "pi");
		const opencodeDb = join(home, "stores", "opencode", "opencode.db");
		const env = {
			PACKBAT_HOME: packbatHome,
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			CODEX_HOME: codexRoot,
			GEMINI_CLI_HOME: geminiHome,
			OPENCODE_DB: opencodeDb,
			PI_CODING_AGENT_SESSION_DIR: piRoot,
		};
		const claude = await makeClaudeStore(claudeRoot);
		const codex = await makeCodexStore(codexRoot);
		const gemini = await makeGeminiStore(geminiRoot);
		const pi = await makePiStore(piRoot);
		const openCode = await makeOpenCodeStore(opencodeDb);
		await mkdir(join(home, ".cursor"), { recursive: true });

		const result = await runCli(["init", "--yes", "--archive-root", archiveRoot, "--offbox", "skip", "--no-activate"], {
			home,
			env,
		});
		openCode.database.close();

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("detected: Claude Code, Codex, pi, OpenCode, Gemini CLI");
		expect(result.stdout).toContain(`found, not yet supported: Cursor CLI (${join(home, ".cursor")})`);
		expect(result.stdout).toContain(`archive: ${archiveRoot}`);
		expect(result.stdout).toContain("archived 8, unchanged 0, failed 0");
		expect(result.stdout).toContain("installed: launchd schedule matches");
		expect(result.stdout).toMatch(/live: (?:launchd job is not loaded|launchd job is loaded from .+; expected .+)/);
		expect(result.stdout).toContain("problems:");

		const config = JSON.parse(await readFile(join(packbatHome, "config.json"), "utf8")) as Record<string, unknown>;
		expect(config).toEqual({
			version: 2,
			machine: (hostname().split(".", 1)[0] ?? "").toLowerCase(),
			archiveRoot,
			sweep: { intervalMinutes: 60 },
			offbox: { mode: "skipped", skippedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
		});

		const cliEntry = await realpath(fileURLToPath(new URL("../bin/packbat.js", import.meta.url)));
		const plistPath = join(home, "Library", "LaunchAgents", "dev.packbat.sync.plist");
		expect(await readFile(plistPath, "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.packbat.sync</string>
	<key>ProgramArguments</key>
	<array>
		<string>${process.execPath}</string>
		<string>${cliEntry}</string>
		<string>sync</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PACKBAT_HOME</key>
		<string>${packbatHome}</string>
		<key>CLAUDE_CONFIG_DIR</key>
		<string>${claudeConfigDir}</string>
		<key>CODEX_HOME</key>
		<string>${codexRoot}</string>
		<key>GEMINI_CLI_HOME</key>
		<string>${geminiHome}</string>
		<key>OPENCODE_DB</key>
		<string>${opencodeDb}</string>
		<key>PI_CODING_AGENT_SESSION_DIR</key>
		<string>${piRoot}</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Minute</key>
		<integer>3</integer>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${join(packbatHome, "logs", "launchd.log")}</string>
	<key>StandardErrorPath</key>
	<string>${join(packbatHome, "logs", "launchd.log")}</string>
</dict>
</plist>
`);

		const machine = config.machine as string;
		for (const [harness, fixture] of [
			["claude-code", claude],
			["codex", codex],
			["gemini", gemini],
			["pi", pi],
		] as const) {
			for (const file of fixture.files) {
				expect(await stat(join(archiveRoot, machine, harness, `${file.relPath}.zst`))).toBeDefined();
			}
		}
		const opencodeSnapshots = join(archiveRoot, machine, "opencode", "snapshots");
		expect(await stat(opencodeSnapshots)).toBeDefined();
		expect(JSON.parse(await readFile(join(packbatHome, "state", "last-success.json"), "utf8"))).toMatchObject({
			ok: true,
			archived: 8,
			unchanged: 0,
			failed: 0,
		});
	});

	test.skipIf(process.platform !== "darwin")(
		"persists a harness root override and doctor validates it without the installing environment",
		async () => {
			const home = await makeTempHome();
			homes.push(home);
			const packbatHome = join(home, "packbat");
			const archiveRoot = join(home, "archive");
			const claudeConfigDir = join(home, "custom claude");
			const installed = await runCli(
				["init", "--yes", "--archive-root", archiveRoot, "--offbox", "skip", "--no-activate"],
				{ home, env: { PACKBAT_HOME: packbatHome, CLAUDE_CONFIG_DIR: claudeConfigDir } },
			);
			expect(installed.code).toBe(0);
			const plistPath = join(home, "Library", "LaunchAgents", "dev.packbat.sync.plist");
			expect(await readFile(plistPath, "utf8")).toContain(
				`<key>CLAUDE_CONFIG_DIR</key>\n\t\t<string>${claudeConfigDir}</string>`,
			);

			const checked = await runCli(["doctor", "--json"], { home, env: { PACKBAT_HOME: packbatHome } });
			const report = JSON.parse(checked.stdout) as {
				facts: Array<{ id: string; status: "ok" | "problem" | "info" }>;
			};
			expect(report.facts.find(({ id }) => id === "installed")).toMatchObject({ status: "ok" });
		},
	);

	test("rejects a different archive root on re-init", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, "packbat");
		const archiveRoot = join(home, "chosen-archive");
		const env = { PACKBAT_HOME: packbatHome };
		const first = await runCli(["init", "--yes", "--archive-root", archiveRoot, "--no-activate"], { home, env });
		expect(first.code).toBe(0);
		const originalConfig = await readFile(join(packbatHome, "config.json"), "utf8");
		const differentRoot = join(home, "must-not-replace");

		const second = await runCli(["init", "--yes", "--archive-root", differentRoot, "--no-activate"], {
			home,
			env,
		});

		expect(second.code).toBe(1);
		expect(second.stdout).toBe("");
		expect(second.stderr).toContain(`archive root is already ${archiveRoot}`);
		expect(second.stderr).toContain("edit config.json to move the archive");
		expect(await readFile(join(packbatHome, "config.json"), "utf8")).toBe(originalConfig);
	});

	test("accepts the configured archive root on re-init", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, "packbat");
		const archiveRoot = join(home, "chosen-archive");
		const env = { PACKBAT_HOME: packbatHome };
		const first = await runCli(["init", "--yes", "--archive-root", archiveRoot, "--no-activate"], { home, env });
		expect(first.code).toBe(0);
		const originalConfig = await readFile(join(packbatHome, "config.json"), "utf8");

		const second = await runCli(["init", "--yes", "--archive-root", archiveRoot, "--no-activate"], { home, env });

		expect(second.code).toBe(0);
		expect(second.stderr).toBe("");
		expect(second.stdout).toContain(`archive: ${archiveRoot}`);
		expect(second.stdout).toContain("archived 0, unchanged 0, failed 0");
		expect(await readFile(join(packbatHome, "config.json"), "utf8")).toBe(originalConfig);
	});

	test("uninstalls only the schedule and is idempotent", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, "packbat");
		const archiveRoot = join(home, "archive");
		const env = { PACKBAT_HOME: packbatHome };
		const setup = await runCli(["init", "--yes", "--archive-root", archiveRoot, "--no-activate"], { home, env });
		expect(setup.code).toBe(0);
		const configPath = join(packbatHome, "config.json");
		const configBefore = await readFile(configPath, "utf8");
		const archiveMarker = join(archiveRoot, "keep-me");
		await writeFile(archiveMarker, "archive stays\n");
		const plistPath = join(home, "Library", "LaunchAgents", "dev.packbat.sync.plist");
		const statePath = join(packbatHome, "state");
		const cronArtifactPath = join(statePath, "schedule.cron");
		const activationMarkerPath = join(statePath, "schedule-activated");
		const lockPath = join(statePath, "sync.lock");
		const lastRunPath = join(statePath, "last-run.json");
		const lastSuccessPath = join(statePath, "last-success.json");
		await writeFile(cronArtifactPath, "synthetic schedule\n");
		await writeFile(activationMarkerPath, "active\n");
		await writeFile(lockPath, "keep lock\n");
		const lastRunBefore = await readFile(lastRunPath, "utf8");
		const lastSuccessBefore = await readFile(lastSuccessPath, "utf8");

		const first = await runCli(["init", "--uninstall"], { home, env: { ...env, PATH: "" } });

		expect(first.code).toBe(0);
		expect(first.stdout).toContain(`removed: ${plistPath}`);
		expect(first.stdout).toContain(`removed: ${cronArtifactPath}`);
		expect(first.stdout).toContain(`removed: ${activationMarkerPath}`);
		await expect(stat(plistPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(cronArtifactPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(activationMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(configPath, "utf8")).toBe(configBefore);
		expect(await readFile(archiveMarker, "utf8")).toBe("archive stays\n");
		expect(await readFile(lockPath, "utf8")).toBe("keep lock\n");
		expect(await readFile(lastRunPath, "utf8")).toBe(lastRunBefore);
		expect(await readFile(lastSuccessPath, "utf8")).toBe(lastSuccessBefore);

		const second = await runCli(["init", "--uninstall"], { home, env: { ...env, PATH: "" } });
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("schedule: nothing installed");
		expect(await readFile(configPath, "utf8")).toBe(configBefore);
	});

	test("requires an explicit mode and rejects unknown flags", async () => {
		const home = await makeTempHome();
		homes.push(home);

		const interactive = await runCli(["init"], { home });
		expect(interactive.code).toBe(1);
		expect(interactive.stderr.trim().split("\n")).toEqual([
			"packbat init: stdin is not a TTY; run `packbat init --yes`",
		]);

		const invalid = await runCli(["init", "--yes", "--wat"], { home });
		expect(invalid.code).toBe(1);
		expect(invalid.stderr).toContain("unknown option --wat");
		expect(invalid.stderr).toContain("Usage: packbat init --yes");

		const invalidValue = await runCli(["init", "--yes", "--offbox", "upload"], { home });
		expect(invalidValue.code).toBe(1);
		expect(invalidValue.stderr).toContain("--offbox only accepts skip");
		expect(invalidValue.stderr).toContain("Usage: packbat init --yes");
	});
});
