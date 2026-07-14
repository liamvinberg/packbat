import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
	appendJsonLine,
	type FixtureFile,
	makeClaudeStore,
	makeCodexStore,
	makeGeminiStore,
	makeOpenCodeStore,
	makePiStore,
} from "./helpers/fixtures.js";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const MACHINE = "test-machine";
const SOURCE_MTIME_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const homes: string[] = [];

interface TestLayout {
	home: string;
	packbatHome: string;
	archiveRoot: string;
	claudeRoot: string;
	codexRoot: string;
	geminiRoot: string;
	piRoot: string;
	opencodeDb: string;
	env: Record<string, string>;
}

async function makeLayout(): Promise<TestLayout> {
	const home = await makeTempHome();
	homes.push(home);
	const packbatHome = join(home, "packbat");
	const archiveRoot = join(home, "archive");
	const claudeConfigDir = join(home, "stores", "claude");
	const codexRoot = join(home, "stores", "codex");
	const geminiHome = join(home, "stores", "gemini");
	const geminiRoot = join(geminiHome, ".gemini", "tmp");
	const piRoot = join(home, "stores", "pi");
	const opencodeDb = join(home, "stores", "opencode", "opencode.db");
	return {
		home,
		packbatHome,
		archiveRoot,
		claudeRoot: join(claudeConfigDir, "projects"),
		codexRoot,
		geminiRoot,
		piRoot,
		opencodeDb,
		env: {
			PACKBAT_HOME: packbatHome,
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			CODEX_HOME: codexRoot,
			GEMINI_CLI_HOME: geminiHome,
			OPENCODE_DB: opencodeDb,
			PI_CODING_AGENT_SESSION_DIR: piRoot,
		},
	};
}

async function writeConfig(layout: TestLayout, overrides: Record<string, unknown> = {}): Promise<void> {
	await mkdir(layout.packbatHome, { recursive: true });
	await writeFile(
		join(layout.packbatHome, "config.json"),
		`${JSON.stringify({
			version: 1,
			machine: MACHINE,
			archiveRoot: layout.archiveRoot,
			sweep: { intervalMinutes: 60 },
			offbox: { mode: "skipped", skippedAt: "2026-01-02T03:04:05.000Z" },
			...overrides,
		})}\n`,
	);
}

function storedPath(layout: TestLayout, harness: string, file: FixtureFile): string {
	return join(layout.archiveRoot, MACHINE, harness, `${file.relPath}.zst`);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("packbat sync", () => {
	test("rejects arguments before reading config or creating archive state", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });

		const result = await runCli(["sync", "--help"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Usage: packbat sync\n");
		await expect(stat(layout.archiveRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("archives every harness verbatim and a second sweep is unchanged", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const claude = await makeClaudeStore(layout.claudeRoot, {
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [
				{ relPath: join("subagents", "agent-a1b2c3d4.jsonl"), mtimeMs: SOURCE_MTIME_MS },
				{ relPath: join("tool-results", "synthetic-result.txt"), mtimeMs: SOURCE_MTIME_MS },
			],
		});
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const fractionalMtimeSeconds = (SOURCE_MTIME_MS + 0.456) / 1000;
		await utimes(codex.files[0]!.absPath, fractionalMtimeSeconds, fractionalMtimeSeconds);
		const pi = await makePiStore(layout.piRoot, { mtimeMs: SOURCE_MTIME_MS });
		const gemini = await makeGeminiStore(layout.geminiRoot, { mtimeMs: SOURCE_MTIME_MS });
		const expected = [
			...claude.files.map((file) => ({ harness: "claude-code", file })),
			...codex.files.map((file) => ({ harness: "codex", file })),
			...pi.files.map((file) => ({ harness: "pi", file })),
			...gemini.files.map((file) => ({ harness: "gemini", file })),
		];

		const first = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(first.code).toBe(0);
		expect(first.stderr).toBe("");
		expect(first.stdout).toContain(`archived ${expected.length}`);
		const storedMtimes = new Map<string, number>();
		for (const { harness, file } of expected) {
			const destination = storedPath(layout, harness, file);
			expect(zstdDecompressSync(await readFile(destination))).toEqual(await readFile(file.absPath));
			const destinationStat = await stat(destination);
			expect(destinationStat.mtimeMs).toBe((await stat(file.absPath)).mtimeMs);
			storedMtimes.set(destination, destinationStat.mtimeMs);
		}
		const indexPath = join(layout.archiveRoot, MACHINE, "index.jsonl");
		const firstIndex = await readFile(indexPath, "utf8");
		expect(firstIndex.trim().split("\n")).toHaveLength(expected.length);
		for (const { harness, file } of expected) {
			expect(firstIndex).toContain(`"path":"${join(harness, `${file.relPath}.zst`)}"`);
		}
		const lastRun = await readJson(join(layout.packbatHome, "state", "last-run.json"));
		expect(lastRun).toMatchObject({ ok: true, archived: expected.length, unchanged: 0, failed: 0 });
		expect(await readJson(join(layout.packbatHome, "state", "last-success.json"))).toEqual(lastRun);
		expect(await readFile(join(layout.packbatHome, "logs", "packbat.log"), "utf8")).toContain(
			`archived ${expected.length}`,
		);

		const second = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(second.code).toBe(0);
		expect(second.stdout).toContain(`unchanged ${expected.length}`);
		expect(await readFile(indexPath, "utf8")).toBe(firstIndex);
		for (const [destination, mtimeMs] of storedMtimes) {
			expect((await stat(destination)).mtimeMs).toBe(mtimeMs);
		}
	});

	test("archives pi sessions directly inside an explicit session directory", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const pi = await makePiStore(layout.piRoot, {
			encodedCwd: ".",
			mtimeMs: SOURCE_MTIME_MS,
		});

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("archived 1");
		expect(zstdDecompressSync(await readFile(storedPath(layout, "pi", pi.files[0]!)))).toEqual(
			await readFile(pi.files[0]!.absPath),
		);
	});

	test("snapshots a WAL database consistently, records its manifest, deduplicates, and repairs its index", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const fixture = await makeOpenCodeStore(layout.opencodeDb, { paddingBytes: 16 * 1024 * 1024, version: "1.17.5" });
		let generation = 0;
		const writer = setInterval(() => {
			generation += 1;
			fixture.database.exec(`
				BEGIN IMMEDIATE;
				UPDATE consistency SET generation = ${generation} WHERE slot = 1;
				UPDATE consistency SET generation = ${generation} WHERE slot = 2;
				COMMIT;
			`);
			if (generation >= 40) {
				clearInterval(writer);
			}
		}, 10);

		try {
			const first = await runCli(["sync"], { home: layout.home, env: layout.env });
			clearInterval(writer);
			expect(first.code, first.stderr).toBe(0);
			expect(generation).toBeGreaterThan(0);

			const snapshotRoot = join(layout.archiveRoot, MACHINE, "opencode", "snapshots");
			const firstSnapshots = (await readdir(snapshotRoot)).sort();
			expect(firstSnapshots).toHaveLength(1);
			expect(firstSnapshots[0]).toMatch(/^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{64}$/);
			const firstDirectory = join(snapshotRoot, firstSnapshots[0]!);
			const payloadPath = join(firstDirectory, "opencode.db.zst");
			const payloadBytes = await readFile(payloadPath);
			const snapshotBytes = zstdDecompressSync(payloadBytes);
			const extractedPath = join(layout.home, "completed-backup.db");
			await writeFile(extractedPath, snapshotBytes);
			const completed = new DatabaseSync(extractedPath, { readOnly: true });
			try {
				expect(completed.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
				expect(completed.prepare("SELECT id FROM session").get()).toEqual({ id: fixture.id });
				const consistency = completed.prepare("SELECT generation FROM consistency ORDER BY slot").all();
				expect(consistency).toHaveLength(2);
				expect(consistency[0]?.generation).toBe(consistency[1]?.generation);
			} finally {
				completed.close();
			}

			const manifest = JSON.parse(await readFile(join(firstDirectory, "manifest.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(manifest).toMatchObject({
				v: 1,
				kind: "db-snapshot",
				harness: "opencode",
				sourcePath: layout.opencodeDb,
				harnessVersion: "1.17.5",
				contentSha256: createHash("sha256").update(snapshotBytes).digest("hex"),
				sizeBytes: snapshotBytes.byteLength,
				sessions: [{ id: fixture.id }],
				payload: "opencode.db.zst",
			});
			expect(await readdir(firstDirectory)).toEqual(["manifest.json", "opencode.db.zst"]);

			const settled = await runCli(["sync"], { home: layout.home, env: layout.env });
			expect(settled.code, settled.stderr).toBe(0);
			const settledSnapshots = (await readdir(snapshotRoot)).sort();
			const deduplicated = await runCli(["sync"], { home: layout.home, env: layout.env });
			expect(deduplicated.code, deduplicated.stderr).toBe(0);
			expect(deduplicated.stdout).toContain("unchanged 1");
			expect((await readdir(snapshotRoot)).sort()).toEqual(settledSnapshots);

			const indexPath = join(layout.archiveRoot, MACHINE, "index.jsonl");
			await rm(indexPath);
			const repaired = await runCli(["sync"], { home: layout.home, env: layout.env });
			expect(repaired.code, repaired.stderr).toBe(0);
			expect(repaired.stdout).toContain("unchanged 1, failed 0, repaired 1");
			expect((await readdir(snapshotRoot)).sort()).toEqual(settledSnapshots);
			const record = JSON.parse((await readFile(indexPath, "utf8")).trim()) as Record<string, unknown>;
			expect(record).toMatchObject({ harness: "opencode", role: "database", sessions: [{ id: fixture.id }] });
		} finally {
			clearInterval(writer);
			fixture.database.close();
		}
	});

	test("rebuilds a missing index from committed payloads without touching them", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const claude = await makeClaudeStore(layout.claudeRoot, { main: { mtimeMs: SOURCE_MTIME_MS } });
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS + 1_000 });
		const pi = await makePiStore(layout.piRoot, { mtimeMs: SOURCE_MTIME_MS + 2_000 });
		const expected = [
			...claude.files.map((file) => ({ harness: "claude-code", file })),
			...codex.files.map((file) => ({ harness: "codex", file })),
			...pi.files.map((file) => ({ harness: "pi", file })),
		];
		expect((await runCli(["sync"], { home: layout.home, env: layout.env })).code).toBe(0);
		const storedMtimes = new Map(
			await Promise.all(
				expected.map(async ({ harness, file }) => {
					const path = storedPath(layout, harness, file);
					return [path, (await stat(path)).mtimeMs] as const;
				}),
			),
		);
		const indexPath = join(layout.archiveRoot, MACHINE, "index.jsonl");
		await rm(indexPath);

		const repaired = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(repaired.code).toBe(0);
		expect(repaired.stdout).toContain(`unchanged ${expected.length}, failed 0, repaired ${expected.length}`);
		const rebuilt = await readFile(indexPath, "utf8");
		expect(rebuilt.trim().split("\n")).toHaveLength(expected.length);
		for (const { harness, file } of expected) {
			expect(rebuilt).toContain(`"path":"${join(harness, `${file.relPath}.zst`)}"`);
		}
		for (const [path, mtimeMs] of storedMtimes) {
			expect((await stat(path)).mtimeMs).toBe(mtimeMs);
		}
		expect(await readJson(join(layout.packbatHome, "state", "last-run.json"))).toMatchObject({
			repaired: expected.length,
		});
		const listed = await runCli(["restore"], { home: layout.home, env: layout.env });
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain(claude.id);
		expect(listed.stdout).toContain(codex.id);
		expect(listed.stdout).toContain(pi.id);
	});

	test("supersedes grown Claude files but skips a changed source older than its archive", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const initialMtimeMs = SOURCE_MTIME_MS;
		const grownMtimeMs = SOURCE_MTIME_MS + 60_000;
		const claude = await makeClaudeStore(layout.claudeRoot, {
			main: { mtimeMs: initialMtimeMs },
			sidecars: [{ relPath: join("subagents", "agent-a1b2c3d4.jsonl"), mtimeMs: initialMtimeMs }],
		});
		await runCli(["sync"], { home: layout.home, env: layout.env });
		for (const file of claude.files) {
			await appendJsonLine(file, { type: "synthetic-growth", sessionId: claude.id }, grownMtimeMs);
		}

		const grown = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(grown.code).toBe(0);
		expect(grown.stdout).toContain("archived 2");
		for (const file of claude.files) {
			expect(zstdDecompressSync(await readFile(storedPath(layout, "claude-code", file)))).toEqual(
				await readFile(file.absPath),
			);
		}
		const indexPath = join(layout.archiveRoot, MACHINE, "index.jsonl");
		const supersededIndex = await readFile(indexPath, "utf8");
		expect(supersededIndex.trim().split("\n")).toHaveLength(4);
		for (const file of claude.files) {
			expect(supersededIndex.match(new RegExp(`\\"source\\":\\"${file.absPath}\\"`, "g"))).toHaveLength(2);
		}

		const main = claude.files[0]!;
		const storedBeforeOlderSource = zstdDecompressSync(await readFile(storedPath(layout, "claude-code", main)));
		await appendJsonLine(main, { type: "synthetic-older-change", sessionId: claude.id });
		const older = new Date(initialMtimeMs - 60_000);
		await utimes(main.absPath, older, older);
		const stale = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(stale.code).toBe(0);
		expect(stale.stdout).toContain("archived 0");
		expect(zstdDecompressSync(await readFile(storedPath(layout, "claude-code", main)))).toEqual(
			storedBeforeOlderSource,
		);
		expect(await readFile(indexPath, "utf8")).toBe(supersededIndex);
	});

	test("succeeds when harness roots are absent and rotates a full log", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const logPath = join(layout.packbatHome, "logs", "packbat.log");
		await mkdir(dirname(logPath), { recursive: true });
		const oldLog = "x".repeat(1024 * 1024);
		await writeFile(logPath, oldLog);

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("archived 0, unchanged 0, failed 0");
		expect(await readFile(`${logPath}.1`, "utf8")).toBe(oldLog);
		const currentLog = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
		expect(currentLog).toHaveLength(2);
		expect(currentLog[0]).toContain("If this laptop dies");
		expect(currentLog[1]).toContain("archived 0, unchanged 0, failed 0");
	});

	test("treats a live lock as successful contention without archiving", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const lockPath = join(layout.packbatHome, "state", "sync.lock");
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("already running");
		await expect(stat(layout.archiveRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await stat(lockPath)).toBeDefined();
	});

	test("removes a dead lock and proceeds", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const lockPath = join(layout.packbatHome, "state", "sync.lock");
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(lockPath, `${JSON.stringify({ pid: 99_999_999, startedAt: new Date().toISOString() })}\n`);

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(0);
		expect(zstdDecompressSync(await readFile(storedPath(layout, "codex", codex.files[0]!)))).toEqual(
			await readFile(codex.files[0]!.absPath),
		);
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("removes an empty crash-artifact lock and proceeds", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const lockPath = join(layout.packbatHome, "state", "sync.lock");
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(lockPath, "");

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(0);
		expect(zstdDecompressSync(await readFile(storedPath(layout, "codex", codex.files[0]!)))).toEqual(
			await readFile(codex.files[0]!.absPath),
		);
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("finishes remaining files and exits 1 when individual archives fail", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		await makeClaudeStore(layout.claudeRoot, { main: { mtimeMs: SOURCE_MTIME_MS } });
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const blockingPath = join(layout.archiveRoot, MACHINE, "claude-code", "-synthetic-project");
		await mkdir(dirname(blockingPath), { recursive: true });
		await writeFile(blockingPath, "blocks destination directories");

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("archived 1, unchanged 0, failed 3");
		expect(result.stderr).toContain("claude-code");
		expect(zstdDecompressSync(await readFile(storedPath(layout, "codex", codex.files[0]!)))).toEqual(
			await readFile(codex.files[0]!.absPath),
		);
		expect(await readJson(join(layout.packbatHome, "state", "last-run.json"))).toMatchObject({
			ok: false,
			archived: 1,
			failed: 3,
		});
		await expect(stat(join(layout.packbatHome, "state", "last-success.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("records a failed run and releases the lock when the sweep cannot read its index", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		await mkdir(join(layout.archiveRoot, MACHINE, "index.jsonl"), { recursive: true });

		const result = await runCli(["sync"], { home: layout.home, env: layout.env });

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("archived 0, unchanged 0, failed 1");
		expect(result.stderr).toContain("sweep:");
		expect(await readJson(join(layout.packbatHome, "state", "last-run.json"))).toMatchObject({
			ok: false,
			archived: 0,
			unchanged: 0,
			failed: 1,
		});
		expect(await readFile(join(layout.packbatHome, "logs", "packbat.log"), "utf8")).toContain("failed 1");
		await expect(stat(join(layout.packbatHome, "state", "sync.lock"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("reports missing and invalid config as operational errors", async () => {
		const layout = await makeLayout();
		const missing = await runCli(["sync"], { home: layout.home, env: layout.env });
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("packbat init");

		await writeConfig(layout, { machine: "NOT SAFE" });
		const invalid = await runCli(["sync"], { home: layout.home, env: layout.env });
		expect(invalid.code).toBe(1);
		expect(invalid.stderr).toContain("must be lowercase and hostname-safe");
	});
});
