import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendJsonLine, makeClaudeStore } from "../../test/helpers/fixtures.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { adapters, getAdapter, unsupportedStores } from "./registry.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "blotter-claude-adapter-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("claudeCodeAdapter", () => {
	test("enumerates a transcript and its recursive sidecars as one main-first unit", async () => {
		const root = await makeRoot();
		const fixture = await makeClaudeStore(root, {
			id: "11111111-1111-4111-8111-111111111111",
			encodedCwd: "-Users-synthetic-project",
		});

		const units = await claudeCodeAdapter.enumerate(root);

		expect(units).toHaveLength(1);
		expect(units[0]?.id).toBe(fixture.id);
		expect(units[0]?.files.map(({ relPath, role }) => ({ relPath, role }))).toEqual([
			{
				relPath: join("-Users-synthetic-project", `${fixture.id}.jsonl`),
				role: "main",
			},
			{
				relPath: join("-Users-synthetic-project", fixture.id, "subagents", "agent-a1b2c3d4.jsonl"),
				role: "sidecar",
			},
			{
				relPath: join("-Users-synthetic-project", fixture.id, "tool-results", "synthetic-result.txt"),
				role: "sidecar",
			},
		]);
		expect(units[0]?.files.every((file) => file.absPath === join(root, file.relPath))).toBe(true);
		expect(units[0]?.files.every((file) => file.sizeBytes > 0 && file.mtimeMs > 0)).toBe(true);
	});

	test("enumerates an orphan sidecar directory as a sidecar-only unit", async () => {
		const root = await makeRoot();
		const fixture = await makeClaudeStore(root, {
			id: "22222222-2222-4222-8222-222222222222",
			main: false,
		});

		const units = await claudeCodeAdapter.enumerate(root);

		expect(units).toHaveLength(1);
		expect(units[0]?.id).toBe(fixture.id);
		expect(units[0]?.files.map((file) => file.role)).toEqual(["sidecar", "sidecar"]);
	});

	test("resolves a non-empty config override and otherwise uses the home default", () => {
		expect(claudeCodeAdapter.storeRoot({ CLAUDE_CONFIG_DIR: "/override/claude" }, "/home/liam")).toBe(
			join("/override/claude", "projects"),
		);
		expect(claudeCodeAdapter.storeRoot({ CLAUDE_CONFIG_DIR: "" }, "/home/liam")).toBe(
			join("/home/liam", ".claude", "projects"),
		);
	});

	test("returns no units for a missing root", async () => {
		const parent = await makeRoot();
		await expect(claudeCodeAdapter.enumerate(join(parent, "missing"))).resolves.toEqual([]);
	});

	test("propagates filesystem errors other than ENOENT", async () => {
		const parent = await makeRoot();
		const fileRoot = join(parent, "not-a-directory");
		await writeFile(fileRoot, "synthetic");
		await expect(claudeCodeAdapter.enumerate(fileRoot)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	test("fixture files support exact mtimes and later JSONL growth", async () => {
		const root = await makeRoot();
		const initialMtimeMs = Date.UTC(2025, 0, 2, 3, 4, 5);
		const appendedMtimeMs = Date.UTC(2025, 0, 2, 3, 5, 6);
		const fixture = await makeClaudeStore(root, { main: { mtimeMs: initialMtimeMs }, sidecars: [] });
		const main = fixture.files[0]!;
		const before = await stat(main.absPath);

		expect(before.mtimeMs).toBe(initialMtimeMs);
		await appendJsonLine(main, { type: "mode", sessionId: fixture.id, mode: "synthetic" }, appendedMtimeMs);
		const after = await stat(main.absPath);
		expect(after.size).toBeGreaterThan(before.size);
		expect(after.mtimeMs).toBe(appendedMtimeMs);
	});

	test("skips metadata and non-matching files", async () => {
		const root = await makeRoot();
		const project = join(root, "-synthetic-project");
		await mkdir(project, { recursive: true });
		await writeFile(join(root, ".DS_Store"), "synthetic");
		await writeFile(join(project, ".DS_Store"), "synthetic");
		await writeFile(join(project, "not-a-session.jsonl"), "{}\n");
		await writeFile(join(project, "11111111-1111-4111-8111-111111111111.txt"), "synthetic");

		await expect(claudeCodeAdapter.enumerate(root)).resolves.toEqual([]);
	});

	test("returns exact restore and resume guidance", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		expect(claudeCodeAdapter.restoreTarget("/store", join("project", `${id}.jsonl`))).toBe(
			join("/store", "project", `${id}.jsonl`),
		);
		expect(claudeCodeAdapter.resumeHint({ id, relPaths: [join("project", `${id}.jsonl`)] })).toEqual([
			"Run from the original project directory:",
			`claude --resume ${id}`,
		]);
	});
});

describe("adapter registry", () => {
	test("lists every supported adapter and resolves known ids", () => {
		expect(adapters.map((adapter) => adapter.id)).toEqual(["claude-code", "codex", "pi"]);
		expect(getAdapter("codex")?.id).toBe("codex");
		expect(getAdapter("unknown")).toBeUndefined();
	});

	test("detects unsupported stores only when their configured paths exist", async () => {
		const home = await makeRoot();
		const xdgDataHome = join(home, "xdg-data");
		const opencodeDb = join(xdgDataHome, "opencode", "opencode.db");
		const overrideDb = join(home, "custom", "opencode.db");
		const geminiRoot = join(home, ".gemini", "tmp");
		const cursorRoot = join(home, ".cursor");
		const byId = new Map(unsupportedStores.map((store) => [store.id, store]));

		expect(byId.get("opencode")?.detect({ XDG_DATA_HOME: xdgDataHome }, home)).toBeNull();
		expect(byId.get("gemini")?.detect({}, home)).toBeNull();
		expect(byId.get("cursor")?.detect({}, home)).toBeNull();

		await mkdir(join(xdgDataHome, "opencode"), { recursive: true });
		await writeFile(opencodeDb, "synthetic sqlite fixture");
		await mkdir(dirname(overrideDb), { recursive: true });
		await writeFile(overrideDb, "synthetic sqlite fixture");
		await mkdir(geminiRoot, { recursive: true });
		await mkdir(cursorRoot, { recursive: true });

		expect(byId.get("opencode")?.detect({ XDG_DATA_HOME: xdgDataHome }, home)).toBe(opencodeDb);
		expect(byId.get("opencode")?.detect({ OPENCODE_DB: overrideDb, XDG_DATA_HOME: xdgDataHome }, home)).toBe(
			overrideDb,
		);
		expect(byId.get("gemini")?.detect({}, home)).toBe(geminiRoot);
		expect(byId.get("cursor")?.detect({}, home)).toBe(cursorRoot);
		expect(unsupportedStores.map(({ id, mutationModel }) => ({ id, mutationModel }))).toEqual([
			{ id: "opencode", mutationModel: "db-snapshot" },
			{ id: "gemini", mutationModel: "append-file" },
			{ id: "cursor", mutationModel: "undisclosed" },
		]);
	});
});
