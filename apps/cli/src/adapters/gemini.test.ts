import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeGeminiStore } from "../../test/helpers/fixtures.js";
import { geminiAdapter } from "./gemini.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "packbat-gemini-adapter-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("geminiAdapter", () => {
	test("recovers the full metadata UUID and archives only the conversational-resume unit", async () => {
		const root = await makeRoot();
		const fixture = await makeGeminiStore(root, {
			id: "44444444-4444-4444-8444-444444444444",
			slug: "quiet-lantern",
			sidecars: [
				{
					relPath: join("chats", "44444444-4444-4444-8444-444444444444", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
				},
				{ relPath: join("logs", "session-44444444-4444-4444-8444-444444444444.jsonl") },
				{ relPath: join("tool-outputs", "session-44444444-4444-4444-8444-444444444444", "full.txt") },
				{ relPath: join("44444444-4444-4444-8444-444444444444", "plans", "plan.md") },
				{ relPath: join("44444444-4444-4444-8444-444444444444", "tracker", "state.json") },
				{ relPath: join("44444444-4444-4444-8444-444444444444", "tasks", "tasks.json") },
				{ relPath: "checkpoint-release.json" },
				{ relPath: join("checkpoints", "file-edit.json") },
			],
		});

		const units = await geminiAdapter.enumerate(root);

		expect(units).toHaveLength(1);
		expect(units[0]?.id).toBe(fixture.id);
		expect(units[0]?.files.map(({ relPath, role }) => ({ relPath, role }))).toEqual(
			fixture.files.map(({ relPath, role }) => ({ relPath, role })),
		);
		expect(units[0]?.files.every((file) => file.absPath === join(root, file.relPath))).toBe(true);
		expect(units[0]?.files.every((file) => file.sizeBytes > 0 && file.mtimeMs > 0)).toBe(true);
	});

	test("keeps the legacy JSON as a sidecar beside a converted JSONL sibling", async () => {
		const root = await makeRoot();
		const id = "55555555-5555-4555-8555-555555555555";
		const legacy = await makeGeminiStore(root, {
			id,
			slug: "legacy-project",
			timestamp: "2025-12-01T01-02",
			legacy: true,
		});
		const legacyUnits = await geminiAdapter.enumerate(root);
		expect(legacyUnits).toHaveLength(1);
		expect(legacyUnits[0]?.files.map((file) => file.relPath)).toEqual([
			legacy.files[0]!.relPath,
			legacy.files[1]!.relPath,
		]);
		const converted = await makeGeminiStore(root, {
			id,
			slug: "legacy-project",
			timestamp: "2025-12-01T01-02",
		});

		const units = await geminiAdapter.enumerate(root);

		expect(units).toHaveLength(1);
		expect(units[0]?.id).toBe(id);
		expect(units[0]?.files.map((file) => file.relPath)).toEqual([
			converted.files[0]!.relPath,
			legacy.files[0]!.relPath,
			converted.files[1]!.relPath,
		]);
		expect(units[0]?.files.find((file) => file.relPath === legacy.files[0]!.relPath)?.role).toBe("sidecar");
		expect(units[0]?.files[0]?.role).toBe("main");
	});

	test("skips malformed, overlong, mismatched, and subagent metadata without failing the store", async () => {
		const root = await makeRoot();
		const chats = join(root, "broken-project", "chats");
		await mkdir(chats, { recursive: true });
		await writeFile(join(root, "broken-project", ".project_root"), "/synthetic/broken\n");
		await writeFile(join(chats, "session-2026-01-02T03-04-66666666.jsonl"), "not json\n{}");
		await writeFile(
			join(chats, "session-2026-01-02T03-04-77777777.jsonl"),
			`${" ".repeat(64 * 1024)}${JSON.stringify({ sessionId: "77777777-7777-4777-8777-777777777777" })}\n`,
		);
		await writeFile(
			join(chats, "session-2026-01-02T03-04-88888888.jsonl"),
			`${JSON.stringify({ sessionId: "99999999-9999-4999-8999-999999999999", kind: "main" })}\n`,
		);
		await writeFile(
			join(chats, "session-2026-01-02T03-04-aaaaaaaa.jsonl"),
			`${JSON.stringify({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "subagent" })}\n`,
		);

		await expect(geminiAdapter.enumerate(root)).resolves.toEqual([]);
	});

	test("uses the nested override root and returns exact restore and resume guidance", () => {
		const id = "44444444-4444-4444-8444-444444444444";
		expect(geminiAdapter.storeRoot({ GEMINI_CLI_HOME: "/override/gemini" }, "/home/liam")).toBe(
			join("/override/gemini", ".gemini", "tmp"),
		);
		expect(geminiAdapter.storeRoot({ GEMINI_CLI_HOME: "" }, "/home/liam")).toBe(join("/home/liam", ".gemini", "tmp"));
		const relPath = join("quiet-lantern", "chats", `session-2026-01-02T03-04-${id.slice(0, 8)}.jsonl`);
		expect(geminiAdapter.restoreTarget("/store", relPath)).toBe(join("/store", relPath));
		expect(geminiAdapter.resumeHint({ id, relPaths: [relPath] })).toEqual([
			"Run from the original project directory:",
			`gemini --resume ${id}`,
		]);
	});

	test("returns no units for an absent store", async () => {
		const parent = await makeRoot();
		await expect(geminiAdapter.enumerate(join(parent, "missing"))).resolves.toEqual([]);
	});
});
