import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
	type FixtureFile,
	type FixtureUnit,
	makeClaudeStore,
	makeCodexStore,
	makeOpenCodeStore,
	makePiStore,
} from "./helpers/fixtures.js";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const MACHINE = "test-machine";
const SOURCE_MTIME_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const homes: string[] = [];

interface TestLayout {
	home: string;
	blotterHome: string;
	archiveRoot: string;
	claudeRoot: string;
	codexRoot: string;
	piRoot: string;
	opencodeDb: string;
	env: Record<string, string>;
}

interface FileSnapshot {
	bytes: Buffer;
	mtimeMs: number;
}

async function makeLayout(): Promise<TestLayout> {
	const home = await makeTempHome();
	homes.push(home);
	const blotterHome = join(home, "blotter");
	const archiveRoot = join(home, "archive");
	const claudeConfigDir = join(home, "stores", "claude");
	const codexRoot = join(home, "stores", "codex");
	const piRoot = join(home, "stores", "pi");
	const opencodeDb = join(home, "stores", "opencode", "opencode.db");
	return {
		home,
		blotterHome,
		archiveRoot,
		claudeRoot: join(claudeConfigDir, "projects"),
		codexRoot,
		piRoot,
		opencodeDb,
		env: {
			BLOTTER_HOME: blotterHome,
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			CODEX_HOME: codexRoot,
			OPENCODE_DB: opencodeDb,
			PI_CODING_AGENT_SESSION_DIR: piRoot,
		},
	};
}

async function writeConfig(layout: TestLayout, blotterHome = layout.blotterHome, machine = MACHINE): Promise<void> {
	await mkdir(blotterHome, { recursive: true });
	await writeFile(
		join(blotterHome, "config.json"),
		`${JSON.stringify({
			version: 1,
			machine,
			archiveRoot: layout.archiveRoot,
			sweep: { intervalMinutes: 60 },
			offbox: { mode: "skipped", skippedAt: "2026-01-02T03:04:05.000Z" },
		})}\n`,
	);
}

async function snapshotFiles(files: readonly FixtureFile[]): Promise<Map<string, FileSnapshot>> {
	return new Map(
		await Promise.all(
			files.map(
				async (file) =>
					[file.relPath, { bytes: await readFile(file.absPath), mtimeMs: (await stat(file.absPath)).mtimeMs }] as const,
			),
		),
	);
}

async function expectRestored(root: string, snapshot: ReadonlyMap<string, FileSnapshot>): Promise<void> {
	for (const [relPath, expected] of snapshot) {
		const restored = join(root, relPath);
		expect(await readFile(restored)).toEqual(expected.bytes);
		expect((await stat(restored)).mtimeMs).toBe(expected.mtimeMs);
	}
}

async function expectMissing(path: string): Promise<void> {
	await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("blotter restore", () => {
	test("lists units and restores every harness byte-for-byte to its resume placement", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const claude = await makeClaudeStore(layout.claudeRoot, {
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [
				{ relPath: join("subagents", "agent-a1b2c3d4.jsonl"), mtimeMs: SOURCE_MTIME_MS + 1_000 },
				{ relPath: join("tool-results", "synthetic-result.txt"), mtimeMs: SOURCE_MTIME_MS + 2_000 },
			],
		});
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS + 3_000 });
		const pi = await makePiStore(layout.piRoot, { mtimeMs: SOURCE_MTIME_MS + 4_000 });
		const fixtures: Array<{ fixture: FixtureUnit; root: string; hints: string[] }> = [
			{
				fixture: claude,
				root: layout.claudeRoot,
				hints: ["Run from the original project directory:", `claude --resume ${claude.id}`],
			},
			{ fixture: codex, root: layout.codexRoot, hints: [`codex resume ${codex.id}`] },
			{ fixture: pi, root: layout.piRoot, hints: [`pi --session ${pi.id}`] },
		];
		const snapshots = new Map(
			await Promise.all(fixtures.map(async ({ fixture }) => [fixture.id, await snapshotFiles(fixture.files)] as const)),
		);
		const synced = await runCli(["sync"], { home: layout.home, env: layout.env });
		expect(synced.code).toBe(0);

		const listed = await runCli(["restore"], { home: layout.home, env: layout.env });

		expect(listed.code).toBe(0);
		expect(listed.stderr).toBe("");
		expect(listed.stdout).toContain(
			`${claude.id} · claude-code · ${MACHINE} · 3 files · ${new Date(SOURCE_MTIME_MS + 2_000).toISOString()}`,
		);
		expect(listed.stdout).toContain(
			`${codex.id} · codex · ${MACHINE} · 1 file · ${new Date(SOURCE_MTIME_MS + 3_000).toISOString()}`,
		);
		expect(listed.stdout).toContain(
			`${pi.id} · pi · ${MACHINE} · 1 file · ${new Date(SOURCE_MTIME_MS + 4_000).toISOString()}`,
		);

		await Promise.all([
			rm(layout.claudeRoot, { recursive: true, force: true }),
			rm(layout.codexRoot, { recursive: true, force: true }),
			rm(layout.piRoot, { recursive: true, force: true }),
		]);
		for (const { fixture, root, hints } of fixtures) {
			const restored = await runCli(["restore", fixture.id], { home: layout.home, env: layout.env });
			expect(restored.code).toBe(0);
			expect(restored.stderr).toBe("");
			expect(restored.stdout).toBe(
				[`restored ${fixture.files.length} file${fixture.files.length === 1 ? "" : "s"} to ${root}`, ...hints, ""].join(
					"\n",
				),
			);
			await expectRestored(root, snapshots.get(fixture.id)!);
		}
	});

	test("refuses every write when any live unit file is newer, then force restores the whole unit", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const claude = await makeClaudeStore(layout.claudeRoot, {
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [
				{ relPath: join("subagents", "agent-a1b2c3d4.jsonl"), mtimeMs: SOURCE_MTIME_MS },
				{ relPath: join("tool-results", "synthetic-result.txt"), mtimeMs: SOURCE_MTIME_MS },
			],
		});
		const snapshot = await snapshotFiles(claude.files);
		expect((await runCli(["sync"], { home: layout.home, env: layout.env })).code).toBe(0);
		await rm(layout.claudeRoot, { recursive: true, force: true });
		const newerFiles = claude.files.slice(0, 2);
		for (const [index, file] of newerFiles.entries()) {
			await mkdir(dirname(file.absPath), { recursive: true });
			await writeFile(file.absPath, `newer live work ${index}\n`);
			const newer = new Date(SOURCE_MTIME_MS + 60_000 + index);
			await utimes(file.absPath, newer, newer);
		}
		const untouched = await snapshotFiles(newerFiles);

		const refused = await runCli(["restore", claude.id], { home: layout.home, env: layout.env });

		expect(refused.code).toBe(1);
		expect(refused.stdout).toBe("");
		for (const file of newerFiles) {
			expect(refused.stderr).toContain(file.absPath);
		}
		await expectRestored(layout.claudeRoot, untouched);
		await expectMissing(claude.files[2]!.absPath);

		const forced = await runCli(["restore", "--force", claude.id], { home: layout.home, env: layout.env });

		expect(forced.code).toBe(0);
		expect(forced.stderr).toBe("");
		await expectRestored(layout.claudeRoot, snapshot);
	});

	test("restores OpenCode only into absence, clears stale sidecars, and leaves its snapshot immutable", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const fixture = await makeOpenCodeStore(layout.opencodeDb, { version: "1.17.5" });
		try {
			const synced = await runCli(["sync"], { home: layout.home, env: layout.env });
			expect(synced.code, synced.stderr).toBe(0);
		} finally {
			fixture.database.close();
		}
		const snapshotRoot = join(layout.archiveRoot, MACHINE, "opencode", "snapshots");
		const snapshotDirectories = await readdir(snapshotRoot);
		expect(snapshotDirectories).toHaveLength(1);
		const payloadPath = join(snapshotRoot, snapshotDirectories[0]!, "opencode.db.zst");
		const archivedBytes = await readFile(payloadPath);
		const completedBackup = zstdDecompressSync(archivedBytes);
		await Promise.all([
			rm(layout.opencodeDb, { force: true }),
			rm(`${layout.opencodeDb}-wal`, { force: true }),
			rm(`${layout.opencodeDb}-shm`, { force: true }),
			rm(join(layout.archiveRoot, MACHINE, "index.jsonl"), { force: true }),
		]);
		await writeFile(`${layout.opencodeDb}-wal`, "stale wal");
		await writeFile(`${layout.opencodeDb}-shm`, "stale shm");

		const restored = await runCli(["restore", fixture.id], { home: layout.home, env: layout.env });
		expect(restored.code, restored.stderr).toBe(0);
		expect(restored.stdout).toBe(`restored 1 file to ${layout.opencodeDb}\nopencode -s ${fixture.id}\n`);
		expect(await readFile(layout.opencodeDb)).toEqual(completedBackup);
		await expectMissing(`${layout.opencodeDb}-wal`);
		await expectMissing(`${layout.opencodeDb}-shm`);

		const resumed = new DatabaseSync(layout.opencodeDb);
		try {
			resumed
				.prepare("UPDATE session SET marker = ?, time_updated = ? WHERE id = ?")
				.run("resume-style mutation", Date.UTC(2026, 0, 3), fixture.id);
		} finally {
			resumed.close();
		}
		expect(await readFile(payloadPath)).toEqual(archivedBytes);

		const refused = await runCli(["restore", "--force", fixture.id], { home: layout.home, env: layout.env });
		const recoveryPath = join(dirname(layout.opencodeDb), `opencode-restored-${fixture.id}.db`);
		expect(refused.code).toBe(1);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toContain(`restore requires an absent OpenCode database: ${layout.opencodeDb}`);
		expect(refused.stderr).toContain(`OPENCODE_DB=${recoveryPath} opencode -s ${fixture.id}`);
		const recoveredSideBySide = await runCli(["restore", fixture.id], {
			home: layout.home,
			env: { ...layout.env, OPENCODE_DB: recoveryPath },
		});
		expect(recoveredSideBySide.code, recoveredSideBySide.stderr).toBe(0);
		expect(await readFile(recoveryPath)).toEqual(completedBackup);
		const live = new DatabaseSync(layout.opencodeDb, { readOnly: true });
		try {
			expect(live.prepare("SELECT marker FROM session WHERE id = ?").get(fixture.id)).toEqual({
				marker: "resume-style mutation",
			});
		} finally {
			live.close();
		}

		await Promise.all([
			rm(layout.opencodeDb, { force: true }),
			rm(`${layout.opencodeDb}-wal`, { force: true }),
			rm(`${layout.opencodeDb}-shm`, { force: true }),
		]);
		const corruptedDatabase = Buffer.from(completedBackup);
		corruptedDatabase[corruptedDatabase.byteLength - 1]! ^= 1;
		await writeFile(payloadPath, zstdCompressSync(corruptedDatabase));
		const corrupt = await runCli(["restore", fixture.id], { home: layout.home, env: layout.env });
		expect(corrupt.code).toBe(1);
		expect(corrupt.stderr).toContain(`archived database is corrupt: ${payloadPath} (content sha256 mismatch)`);
		await expectMissing(layout.opencodeDb);
	});

	test("refuses a corrupt archived payload before writing and still restores an intact unit", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const claude = await makeClaudeStore(layout.claudeRoot, {
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [{ relPath: join("tool-results", "synthetic-result.txt"), mtimeMs: SOURCE_MTIME_MS }],
		});
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const codexSnapshot = await snapshotFiles(codex.files);
		expect((await runCli(["sync"], { home: layout.home, env: layout.env })).code).toBe(0);
		const corruptPath = join(layout.archiveRoot, MACHINE, "claude-code", `${claude.files[0]!.relPath}.zst`);
		const corruptBytes = await readFile(corruptPath);
		corruptBytes[Math.floor(corruptBytes.byteLength / 2)]! ^= 1;
		await writeFile(corruptPath, corruptBytes);
		await Promise.all([
			rm(layout.claudeRoot, { recursive: true, force: true }),
			rm(layout.codexRoot, { recursive: true, force: true }),
		]);

		const refused = await runCli(["restore", "--force", claude.id], { home: layout.home, env: layout.env });

		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(`archived file is corrupt: ${corruptPath} (sha256 mismatch)`);
		for (const file of claude.files) {
			await expectMissing(file.absPath);
		}

		const intact = await runCli(["restore", codex.id], { home: layout.home, env: layout.env });
		expect(intact.code).toBe(0);
		await expectRestored(layout.codexRoot, codexSnapshot);
	});

	test("resolves unique prefixes and reports ambiguous, unknown, and unsupported arguments", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const first = await makeClaudeStore(layout.claudeRoot, {
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			encodedCwd: "-first-project",
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [],
		});
		const second = await makeClaudeStore(layout.claudeRoot, {
			id: "aaaabbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			encodedCwd: "-second-project",
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [],
		});
		expect((await runCli(["sync"], { home: layout.home, env: layout.env })).code).toBe(0);
		await rm(layout.claudeRoot, { recursive: true, force: true });

		const unique = await runCli(["restore", "aaaaaaaa"], { home: layout.home, env: layout.env });
		expect(unique.code).toBe(0);
		expect(unique.stdout).toContain(`claude --resume ${first.id}`);
		await expectMissing(second.files[0]!.absPath);

		const ambiguous = await runCli(["restore", "aaaa"], { home: layout.home, env: layout.env });
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.stderr).toContain(first.id);
		expect(ambiguous.stderr).toContain(second.id);

		const unknown = await runCli(["restore", "ffffffff"], { home: layout.home, env: layout.env });
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("ffffffff");

		const missingIdentity = await runCli(["restore", "--from-remote", first.id], {
			home: layout.home,
			env: layout.env,
		});
		expect(missingIdentity.code).toBe(1);
		expect(missingIdentity.stderr).toContain("--from-remote requires --identity");
		expect(missingIdentity.stderr).toContain("Usage: blotter restore");

		const shortFlag = await runCli(["restore", "-x"], { home: layout.home, env: layout.env });
		expect(shortFlag.code).toBe(1);
		expect(shortFlag.stderr).toContain("unknown option -x");
		expect(shortFlag.stderr).toContain("Usage: blotter restore");
	});

	test("restores archived Codex units and selects only the newest location when both states exist", async () => {
		const layout = await makeLayout();
		await writeConfig(layout);
		const archived = await makeCodexStore(layout.codexRoot, {
			id: "44444444-4444-4444-8444-444444444444",
			archived: true,
			mtimeMs: SOURCE_MTIME_MS,
		});
		const bothId = "55555555-5555-4555-8555-555555555555";
		const olderActive = await makeCodexStore(layout.codexRoot, {
			id: bothId,
			timestamp: "2026-01-02T03-04-05",
			mtimeMs: SOURCE_MTIME_MS,
		});
		const newerArchived = await makeCodexStore(layout.codexRoot, {
			id: bothId,
			archived: true,
			timestamp: "2026-01-02T04-05-06",
			mtimeMs: SOURCE_MTIME_MS + 60_000,
		});
		const activeNewestId = "66666666-6666-4666-8666-666666666666";
		const olderArchived = await makeCodexStore(layout.codexRoot, {
			id: activeNewestId,
			archived: true,
			timestamp: "2026-01-02T05-06-07",
			mtimeMs: SOURCE_MTIME_MS,
		});
		const newerActive = await makeCodexStore(layout.codexRoot, {
			id: activeNewestId,
			timestamp: "2026-01-02T06-07-08",
			mtimeMs: SOURCE_MTIME_MS + 120_000,
		});
		const archivedSnapshot = await snapshotFiles(archived.files);
		const newestSnapshot = await snapshotFiles(newerArchived.files);
		const newestActiveSnapshot = await snapshotFiles(newerActive.files);
		expect((await runCli(["sync"], { home: layout.home, env: layout.env })).code).toBe(0);

		const listed = await runCli(["restore"], { home: layout.home, env: layout.env });
		expect(listed.stdout).toContain(`${archived.id} · codex · ${MACHINE} · 1 file ·`);
		expect(listed.stdout).toContain(
			`${archived.id} · codex · ${MACHINE} · 1 file · ${new Date(SOURCE_MTIME_MS).toISOString()} · archived`,
		);
		expect(listed.stdout).toContain(
			`${bothId} · codex · ${MACHINE} · 1 file · ${new Date(SOURCE_MTIME_MS + 60_000).toISOString()} · archived`,
		);
		expect(listed.stdout).toContain(
			`${activeNewestId} · codex · ${MACHINE} · 1 file · ${new Date(SOURCE_MTIME_MS + 120_000).toISOString()}\n`,
		);
		await rm(layout.codexRoot, { recursive: true, force: true });

		const restoredArchived = await runCli(["restore", archived.id], { home: layout.home, env: layout.env });
		expect(restoredArchived.code).toBe(0);
		expect(restoredArchived.stdout).toBe(
			[
				`restored 1 file to ${layout.codexRoot}`,
				`codex unarchive ${archived.id}`,
				`codex resume ${archived.id}`,
				"",
			].join("\n"),
		);
		await expectRestored(layout.codexRoot, archivedSnapshot);

		const restoredBoth = await runCli(["restore", bothId], { home: layout.home, env: layout.env });
		expect(restoredBoth.code).toBe(0);
		expect(restoredBoth.stdout).toContain(`superseded codex location: ${olderActive.files[0]!.relPath}\n`);
		expect(restoredBoth.stdout).toContain(`codex unarchive ${bothId}\ncodex resume ${bothId}\n`);
		await expectRestored(layout.codexRoot, newestSnapshot);
		await expectMissing(olderActive.files[0]!.absPath);

		const restoredActive = await runCli(["restore", activeNewestId], { home: layout.home, env: layout.env });
		expect(restoredActive.code).toBe(0);
		expect(restoredActive.stdout).toBe(
			[
				`superseded codex location: ${olderArchived.files[0]!.relPath}`,
				`restored 1 file to ${layout.codexRoot}`,
				`codex resume ${activeNewestId}`,
				"",
			].join("\n"),
		);
		await expectRestored(layout.codexRoot, newestActiveSnapshot);
		await expectMissing(olderArchived.files[0]!.absPath);
	});

	test("lists and restores another machine tree through the default machine config", async () => {
		const layout = await makeLayout();
		await writeConfig(layout, layout.blotterHome, "newbox");
		const oldboxHome = join(layout.home, "oldbox-blotter");
		await writeConfig(layout, oldboxHome, "oldbox");
		const codex = await makeCodexStore(layout.codexRoot, { mtimeMs: SOURCE_MTIME_MS });
		const snapshot = await snapshotFiles(codex.files);
		const oldboxEnv = { ...layout.env, BLOTTER_HOME: oldboxHome };
		expect((await runCli(["sync"], { home: layout.home, env: oldboxEnv })).code).toBe(0);
		await rm(layout.codexRoot, { recursive: true, force: true });

		const defaultList = await runCli(["restore"], { home: layout.home, env: layout.env });
		expect(defaultList.code).toBe(0);
		expect(defaultList.stdout).toBe("no archived sessions for newbox\n");
		const oldboxList = await runCli(["restore", "--machine", "oldbox"], {
			home: layout.home,
			env: layout.env,
		});
		expect(oldboxList.code).toBe(0);
		expect(oldboxList.stdout).toContain(`${codex.id} · codex · oldbox · 1 file ·`);

		const restored = await runCli(["restore", codex.id, "--machine", "oldbox"], {
			home: layout.home,
			env: layout.env,
		});
		expect(restored.code).toBe(0);
		expect(restored.stdout).toContain(`restored 1 file to ${layout.codexRoot}`);
		await expectRestored(layout.codexRoot, snapshot);
	});
});
