import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeCodexStore } from "../../test/helpers/fixtures.js";
import { codexAdapter } from "./codex.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "blotter-codex-adapter-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("codexAdapter", () => {
	test("enumerates active and archived rollouts as separate main-file units", async () => {
		const root = await makeRoot();
		const active = await makeCodexStore(root, {
			id: "11111111-1111-4111-8111-111111111111",
			timestamp: "2026-02-03T04-05-06",
		});
		const archived = await makeCodexStore(root, {
			id: "22222222-2222-4222-8222-222222222222",
			archived: true,
			timestamp: "2025-11-12T13-14-15",
		});

		const units = await codexAdapter.enumerate(root);

		expect(units.map((unit) => unit.id)).toEqual([archived.id, active.id]);
		expect(units.map((unit) => unit.files.map(({ relPath, role }) => ({ relPath, role })))).toEqual([
			[{ relPath: join("archived_sessions", `rollout-2025-11-12T13-14-15-${archived.id}.jsonl`), role: "main" }],
			[
				{
					relPath: join("sessions", "2026", "02", "03", `rollout-2026-02-03T04-05-06-${active.id}.jsonl`),
					role: "main",
				},
			],
		]);
		expect(units.every((unit) => unit.files[0]?.absPath === join(root, unit.files[0]?.relPath ?? ""))).toBe(true);
	});

	test("builds a rollout whose first session_meta payload id matches its filename id", async () => {
		const root = await makeRoot();
		const fixture = await makeCodexStore(root, { id: "33333333-3333-4333-8333-333333333333" });
		const firstLine = (await readFile(fixture.files[0]!.absPath, "utf8")).split("\n")[0];

		expect(JSON.parse(firstLine ?? "null")).toMatchObject({
			type: "session_meta",
			payload: { id: fixture.id },
		});
	});

	test("resolves a non-empty Codex home override and otherwise uses the home default", () => {
		expect(codexAdapter.storeRoot({ CODEX_HOME: "/override/codex" }, "/home/liam")).toBe("/override/codex");
		expect(codexAdapter.storeRoot({ CODEX_HOME: "" }, "/home/liam")).toBe(join("/home/liam", ".codex"));
	});

	test("returns no units for a missing root", async () => {
		const parent = await makeRoot();
		await expect(codexAdapter.enumerate(join(parent, "missing"))).resolves.toEqual([]);
	});

	test("propagates filesystem errors other than ENOENT", async () => {
		const parent = await makeRoot();
		const fileRoot = join(parent, "not-a-directory");
		await writeFile(fileRoot, "synthetic");
		await expect(codexAdapter.enumerate(fileRoot)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	test("skips metadata, malformed date trees, and non-matching files", async () => {
		const root = await makeRoot();
		const activeDay = join(root, "sessions", "2026", "01", "02");
		const malformedDay = join(root, "sessions", "2026", "1", "02");
		const archived = join(root, "archived_sessions");
		await mkdir(activeDay, { recursive: true });
		await mkdir(malformedDay, { recursive: true });
		await mkdir(archived, { recursive: true });
		await writeFile(join(root, ".DS_Store"), "synthetic");
		await writeFile(join(activeDay, ".DS_Store"), "synthetic");
		await writeFile(join(activeDay, "rollout-without-an-id.jsonl"), "{}\n");
		await writeFile(
			join(malformedDay, "rollout-2026-01-02T03-04-05-11111111-1111-4111-8111-111111111111.jsonl"),
			"{}\n",
		);
		await writeFile(
			join(archived, "rollout-2026-01-02T03-04-05-11111111-1111-4111-8111-111111111111.txt"),
			"synthetic",
		);

		await expect(codexAdapter.enumerate(root)).resolves.toEqual([]);
	});

	test("returns exact active and archived resume guidance", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const activeRelPath = join("sessions", "2026", "01", "02", `rollout-synthetic-${id}.jsonl`);
		const archivedRelPath = join("archived_sessions", `rollout-synthetic-${id}.jsonl`);
		expect(codexAdapter.restoreTarget("/store", activeRelPath)).toBe(join("/store", activeRelPath));
		expect(codexAdapter.resumeHint({ id, relPaths: [activeRelPath] })).toEqual([`codex resume ${id}`]);
		expect(codexAdapter.resumeHint({ id, relPaths: [archivedRelPath] })).toEqual([
			`codex unarchive ${id}`,
			`codex resume ${id}`,
		]);
	});
});
