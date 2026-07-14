import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
	makeRetrievalLayout,
	type RetrievalLayout,
	writeArchivedBytes,
	writeArchivedJsonl,
} from "./helpers/retrieval-fixtures.js";
import { runCli } from "./helpers/run-cli.js";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";
const PI_ID = "33333333-3333-4333-8333-333333333333";
const homes: string[] = [];

interface SearchJson {
	v: 1;
	query: string;
	filters: { harness: string | null; machine: string | null; project: string | null; since: string | null };
	results: Array<{
		key: string;
		unit: string;
		project: string | null;
		turn: number;
		timestamp: string | null;
		role: string;
		snippet: string;
		filesTouched: string[];
		commands: string[];
	}>;
	truncated: boolean;
	warnings: Array<{ code: string; unit: string; source: string; line: number | null; detail: string }>;
}

async function layout(): Promise<RetrievalLayout> {
	const value = await makeRetrievalLayout();
	homes.push(value.home);
	return value;
}

function command(layout: RetrievalLayout, args: string[]) {
	return runCli(args, { home: layout.home, env: layout.env });
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("packbat retrieval", () => {
	test("reports command-specific search and show usage errors", async () => {
		const test = await layout();

		const search = await command(test, ["search", "--wat"]);
		expect(search.code).toBe(1);
		expect(search.stdout).toBe("");
		expect(search.stderr).toContain("packbat search: unknown option --wat");
		expect(search.stderr).toContain("Usage: packbat search <query>");

		const show = await command(test, ["show", "--wat"]);
		expect(show.code).toBe(1);
		expect(show.stdout).toBe("");
		expect(show.stderr).toContain("packbat show: unknown option --wat");
		expect(show.stderr).toContain("Usage: packbat show <unit-or-key>");
	});

	test("searches Claude turns and show keeps null and empty fields stable", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [
				{
					type: "user",
					sessionId: CLAUDE_ID,
					timestamp: "2026-01-02T03:04:05Z",
					message: { role: "user", content: "Needle prompt without a project." },
				},
				{
					type: "assistant",
					message: { role: "assistant", content: [{ type: "text", text: "Needle response." }] },
				},
			],
		});

		const searched = await command(test, ["search", "Needle", "--json"]);
		expect(searched.code).toBe(0);
		const search = JSON.parse(searched.stdout) as SearchJson;
		expect(search).toMatchObject({
			v: 1,
			query: "Needle",
			filters: { harness: null, machine: null, project: null, since: null },
			truncated: false,
			warnings: [],
		});
		expect(search.results).toHaveLength(2);
		expect(search.results.find((result) => result.timestamp === null)).toMatchObject({
			project: null,
			timestamp: null,
			filesTouched: [],
			commands: [],
		});

		const shown = await command(test, ["show", CLAUDE_ID.slice(0, 12), "--json"]);
		expect(shown.code).toBe(0);
		const report = JSON.parse(shown.stdout) as Record<string, unknown>;
		expect(report).toMatchObject({
			v: 1,
			unit: {
				key: `test-machine/claude-code/${CLAUDE_ID}`,
				projects: [],
				startedAt: "2026-01-02T03:04:05.000Z",
				updatedAt: "2026-01-02T03:04:05.000Z",
			},
			warnings: [],
		});
	});

	test("keeps known records around unknown and malformed middle and final lines", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [
				{ type: "future-event", payload: "ignored" },
				"{broken middle",
				{ type: "user", message: { role: "user", content: "survives malformed records" } },
				"{broken final",
			],
		});

		const searched = await command(test, ["search", "survives", "--json"]);
		const report = JSON.parse(searched.stdout) as SearchJson;
		expect(searched.code).toBe(0);
		expect(report.results).toHaveLength(1);
		expect(report.warnings.map((warning) => warning.code)).toEqual([
			"unknown-record",
			"malformed-json",
			"malformed-json",
		]);
	});

	test("reports zstd corruption and show refuses the unit without cached fallback", async () => {
		const test = await layout();
		await writeArchivedBytes({
			layout: test,
			machine: "test-machine",
			harness: "pi",
			unit: PI_ID,
			relPath: `--synthetic--/2026-01-02T03-04-05-000Z_${PI_ID}.jsonl`,
			role: "main",
			raw: Buffer.from("not zstd"),
			includeIndex: true,
			corruptZstd: true,
		});

		const searched = await command(test, ["search", "anything", "--json"]);
		const report = JSON.parse(searched.stdout) as SearchJson;
		expect(searched.code).toBe(0);
		expect(report.results).toEqual([]);
		expect(report.warnings).toEqual([
			expect.objectContaining({ code: "zstd-corrupt", unit: `test-machine/pi/${PI_ID}`, line: null }),
		]);

		const shown = await command(test, ["show", PI_ID, "--json"]);
		expect(shown.code).toBe(1);
		expect(shown.stdout).toBe("");
		expect(shown.stderr).toContain("zstd-corrupt");
		expect(shown.stderr).toContain(`test-machine/pi/--synthetic--/2026-01-02T03-04-05-000Z_${PI_ID}.jsonl.zst`);
	});

	test("deduplicates Codex response_item and event_msg display messages", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "codex",
			unit: CODEX_ID,
			relPath: `sessions/2026/01/02/rollout-2026-01-02T03-04-05-${CODEX_ID}.jsonl`,
			lines: [
				{ type: "session_meta", timestamp: "2026-01-02T03:04:05Z", payload: { id: CODEX_ID, cwd: "/synthetic" } },
				{
					type: "response_item",
					timestamp: "2026-01-02T03:04:06Z",
					payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "dedup needle" }] },
				},
				{
					type: "event_msg",
					timestamp: "2026-01-02T03:04:06Z",
					payload: { type: "agent_message", message: "dedup needle" },
				},
			],
		});

		const result = JSON.parse((await command(test, ["search", "dedup", "--json"])).stdout) as SearchJson;
		expect(result.results).toHaveLength(1);
	});

	test("reads pi versions 1 through 3 in file order", async () => {
		const test = await layout();
		for (const version of [1, 2, 3]) {
			const id = `${version}${PI_ID.slice(1)}`;
			await writeArchivedJsonl({
				layout: test,
				harness: "pi",
				unit: id,
				relPath: `--synthetic--/2026-01-0${version}T03-04-05-000Z_${id}.jsonl`,
				lines: [
					{ type: "session", version, id, cwd: "/synthetic" },
					{ type: "message", id: "branch-a", parentId: null, message: { role: "user", content: `branch v${version}` } },
					{
						type: "message",
						id: "branch-b",
						parentId: null,
						message: { role: "user", content: `abandoned v${version}` },
					},
				],
			});
		}

		const result = JSON.parse((await command(test, ["search", "abandoned", "--json"])).stdout) as SearchJson;
		expect(result.results.map((hit) => hit.snippet).sort()).toEqual(["abandoned v1", "abandoned v2", "abandoned v3"]);
	});

	test("invalidates a cached harness parse when its reader version is stale", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [{ type: "user", message: { role: "user", content: "fresh reader text" } }],
		});
		await command(test, ["search", "fresh", "--json"]);
		const databasePath = join(test.packbatHome, "cache", "retrieval.sqlite");
		const database = new DatabaseSync(databasePath);
		database.prepare("UPDATE turns SET text = 'stale cache text'").run();
		database.prepare("UPDATE archive_files SET reader_version = 0").run();
		database.close();

		const fresh = JSON.parse((await command(test, ["search", "fresh", "--json"])).stdout) as SearchJson;
		const stale = JSON.parse((await command(test, ["search", "stale", "--json"])).stdout) as SearchJson;
		expect(fresh.results).toHaveLength(1);
		expect(stale.results).toHaveLength(0);
	});

	test("refreshes a whole unit when a sidecar changes", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [{ type: "user", timestamp: "2026-01-02T03:04:05Z", message: { role: "user", content: "main text" } }],
		});
		const sidecar = await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}/subagents/agent-a.jsonl`,
			role: "sidecar",
			mtimeMs: 1_800_000_000_000,
			lines: [{ type: "user", timestamp: "2026-01-02T03:04:06Z", message: { role: "user", content: "old sidecar" } }],
		});
		expect((JSON.parse((await command(test, ["search", "old", "--json"])).stdout) as SearchJson).results).toHaveLength(
			1,
		);

		const replacement = await writeArchivedBytes({
			layout: test,
			machine: "test-machine",
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}/subagents/agent-a.jsonl`,
			role: "sidecar",
			raw: Buffer.from(
				'{"type":"user","timestamp":"2026-01-02T03:04:06Z","message":{"role":"user","content":"new sidecar"}}\n',
			),
			mtimeMs: 1_800_000_001_000,
			includeIndex: false,
		});
		expect(replacement.archivePath).toBe(sidecar.archivePath);
		const result = JSON.parse((await command(test, ["search", "sidecar", "--json"])).stdout) as SearchJson;
		expect(result.results.map((hit) => hit.snippet)).toEqual(["new sidecar"]);
	});

	test("requires ambiguous native ids to be resolved with a full key", async () => {
		const test = await layout();
		for (const machine of ["first-machine", "second-machine"]) {
			await writeArchivedJsonl({
				layout: test,
				machine,
				harness: "claude-code",
				unit: CLAUDE_ID,
				relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
				lines: [{ type: "user", message: { role: "user", content: machine } }],
			});
		}

		const ambiguous = await command(test, ["show", CLAUDE_ID, "--json"]);
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.stderr).toContain(`first-machine/claude-code/${CLAUDE_ID}`);
		expect(ambiguous.stderr).toContain(`second-machine/claude-code/${CLAUDE_ID}`);
		const exact = await command(test, ["show", `first-machine/claude-code/${CLAUDE_ID}`, "--json"]);
		expect(exact.code).toBe(0);
	});

	test("leaves the old database intact when an atomic rebuild is interrupted", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [{ type: "user", message: { role: "user", content: "durable old cache" } }],
		});
		const first = await command(test, ["search", "--rebuild", "--json"]);
		expect(first.code).toBe(0);
		const databasePath = join(test.packbatHome, "cache", "retrieval.sqlite");
		const before = await readFile(databasePath);
		const cacheDirectory = join(test.packbatHome, "cache");
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: Array.from({ length: 20_000 }, (_, index) => ({
				type: "user",
				message: { role: "user", content: `replacement ${index}` },
			})),
		});
		const cliEntry = fileURLToPath(new URL("../bin/packbat.js", import.meta.url));
		const child = spawn(process.execPath, [cliEntry, "search", "--rebuild", "--json"], {
			cwd: test.home,
			env: { PATH: process.env.PATH ?? "", HOME: test.home, ...test.env },
			stdio: "ignore",
		});
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("rebuild temporary database did not appear")), 5_000);
			const poll = setInterval(async () => {
				const entries = await readdir(cacheDirectory);
				if (entries.some((entry) => entry.startsWith(".retrieval.sqlite.tmp-"))) {
					clearInterval(poll);
					clearTimeout(timeout);
					child.kill("SIGKILL");
					resolve();
				}
			}, 1);
		});
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		expect(await readFile(databasePath)).toEqual(before);
	});

	test("bounds results at 50 and marks truncation", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: Array.from({ length: 51 }, (_, index) => ({
				type: "user",
				timestamp: new Date(Date.UTC(2026, 0, 2, 3, index)).toISOString(),
				message: { role: "user", content: `bounded needle ${index}` },
			})),
		});
		const report = JSON.parse((await command(test, ["search", "needle", "--json"])).stdout) as SearchJson;
		expect(report.results).toHaveLength(50);
		expect(report.truncated).toBe(true);
	});

	test("show reads raw archives without the retrieval writer lock", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [{ type: "user", message: { role: "user", content: "readable while a rebuild runs" } }],
		});
		const statePath = join(test.packbatHome, "state");
		await mkdir(statePath, { recursive: true });
		// Hold the writer lock with this live test process's pid, as a rebuild would.
		await writeFile(
			join(statePath, "retrieval.lock"),
			`${JSON.stringify({ pid: process.pid, startedAt: "2026-01-02T03:04:05.000Z" })}\n`,
		);

		const shown = await command(test, ["show", CLAUDE_ID, "--json"]);
		expect(shown.code, shown.stderr).toBe(0);

		const rebuilt = await command(test, ["search", "--rebuild", "--json"]);
		expect(rebuilt.code).toBe(1);
		expect(rebuilt.stderr).toContain("already running");
	});

	test("excludes db-snapshot archives from retrieval until they have a reader", async () => {
		const test = await layout();
		await writeArchivedJsonl({
			layout: test,
			harness: "claude-code",
			unit: CLAUDE_ID,
			relPath: `-synthetic/${CLAUDE_ID}.jsonl`,
			lines: [{ type: "user", message: { role: "user", content: "session needle" } }],
		});
		const snapshotUnit = "20260102T030405.000Z-synthetic";
		const relativePath = `opencode/snapshots/${snapshotUnit}/opencode.db.zst`;
		const payload = zstdCompressSync(Buffer.from("SQLite format 3 synthetic database bytes"));
		const payloadPath = join(test.archiveRoot, "test-machine", ...relativePath.split("/"));
		await mkdir(dirname(payloadPath), { recursive: true });
		await writeFile(payloadPath, payload);
		const record = {
			v: 1,
			path: relativePath,
			harness: "opencode",
			machine: "test-machine",
			unit: snapshotUnit,
			role: "database",
			source: "/synthetic/opencode.db",
			sourceMtimeMs: 1_700_000_000_000,
			sourceSize: 4096,
			storedSize: payload.byteLength,
			sha256: createHash("sha256").update(payload).digest("hex"),
			archivedAt: "2026-01-02T03:04:05.000Z",
			contentSha256: createHash("sha256").update("synthetic").digest("hex"),
			snapshotAt: "2026-01-02T03:04:05.000Z",
			harnessVersion: "1.17.5",
			sessions: [{ id: "ses_synthetic", timeCreated: 1_700_000_000_000, timeUpdated: 1_700_000_001_000 }],
		};
		const indexPath = join(test.archiveRoot, "test-machine", "index.jsonl");
		await writeFile(indexPath, `${await readFile(indexPath, "utf8")}${JSON.stringify(record)}\n`);

		const rebuilt = await command(test, ["search", "--rebuild", "--json"]);
		expect(rebuilt.code, rebuilt.stderr).toBe(0);
		const searched = JSON.parse(
			(await command(test, ["search", "needle OR synthetic", "--json"])).stdout,
		) as SearchJson;
		expect(searched.results).toHaveLength(1);
		expect(searched.results[0]).toMatchObject({ harness: "claude-code" });
		expect(searched.warnings).toEqual([]);

		const shown = await command(test, ["show", "ses_synthetic", "--json"]);
		expect(shown.code).toBe(1);
	});
});
