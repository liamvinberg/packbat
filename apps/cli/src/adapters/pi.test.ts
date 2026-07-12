import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makePiStore } from "../../test/helpers/fixtures.js";
import { piAdapter } from "./pi.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "blotter-pi-adapter-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("piAdapter", () => {
	test("enumerates a session file as one main-file unit and parses its trailing uuid", async () => {
		const root = await makeRoot();
		const fixture = await makePiStore(root, {
			id: "11111111-1111-4111-8111-111111111111",
			encodedCwd: "--Users-synthetic-project--",
			timestamp: "2026-02-03T04-05-06-007Z",
		});

		const units = await piAdapter.enumerate(root);

		expect(units).toHaveLength(1);
		expect(units[0]?.id).toBe(fixture.id);
		expect(units[0]?.files.map(({ relPath, role }) => ({ relPath, role }))).toEqual([
			{
				relPath: join("--Users-synthetic-project--", `2026-02-03T04-05-06-007Z_${fixture.id}.jsonl`),
				role: "main",
			},
		]);
		expect(units[0]?.files[0]?.absPath).toBe(join(root, units[0]?.files[0]?.relPath ?? ""));
		expect(units[0]?.files[0]?.sizeBytes).toBeGreaterThan(0);
	});

	test("builds a versioned session header carrying the filename id", async () => {
		const root = await makeRoot();
		const fixture = await makePiStore(root, { id: "22222222-2222-4222-8222-222222222222" });
		const firstLine = (await readFile(fixture.files[0]!.absPath, "utf8")).split("\n")[0];

		expect(JSON.parse(firstLine ?? "null")).toMatchObject({ type: "session", version: 3, id: fixture.id });
	});

	test("rejects a fixture timestamp that is not a filename-safe ISO timestamp", async () => {
		const root = await makeRoot();
		await expect(makePiStore(root, { timestamp: "not-an-iso-timestamp" })).rejects.toThrow(
			"invalid pi fixture timestamp",
		);
	});

	test("resolves a non-empty sessions-dir override and otherwise uses the home default", () => {
		expect(piAdapter.storeRoot({ PI_CODING_AGENT_SESSION_DIR: "/override/pi-sessions" }, "/home/liam")).toBe(
			"/override/pi-sessions",
		);
		expect(piAdapter.storeRoot({ PI_CODING_AGENT_SESSION_DIR: "" }, "/home/liam")).toBe(
			join("/home/liam", ".pi", "agent", "sessions"),
		);
	});

	test("returns no units for a missing root", async () => {
		const parent = await makeRoot();
		await expect(piAdapter.enumerate(join(parent, "missing"))).resolves.toEqual([]);
	});

	test("propagates filesystem errors other than ENOENT", async () => {
		const parent = await makeRoot();
		const fileRoot = join(parent, "not-a-directory");
		await writeFile(fileRoot, "synthetic");
		await expect(piAdapter.enumerate(fileRoot)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	test("skips metadata, nested files, and non-matching files", async () => {
		const root = await makeRoot();
		const project = join(root, "--synthetic-project--");
		const nested = join(project, "nested");
		await mkdir(nested, { recursive: true });
		await writeFile(join(root, ".DS_Store"), "synthetic");
		await writeFile(join(project, ".DS_Store"), "synthetic");
		await writeFile(join(project, "session-without-an-id.jsonl"), "{}\n");
		await writeFile(join(project, "2026-01-02T03-04-05-000Z_not-a-uuid.jsonl"), "{}\n");
		await writeFile(join(project, "not-an-iso_11111111-1111-4111-8111-111111111111.jsonl"), "{}\n");
		await writeFile(join(nested, "2026-01-02T03-04-05-000Z_11111111-1111-4111-8111-111111111111.jsonl"), "{}\n");

		await expect(piAdapter.enumerate(root)).resolves.toEqual([]);
	});

	test("returns exact restore and resume guidance", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const relPath = join("--synthetic-project--", `2026-01-02T03-04-05-000Z_${id}.jsonl`);
		expect(piAdapter.restoreTarget("/store", relPath)).toBe(join("/store", relPath));
		expect(piAdapter.resumeHint({ id, relPaths: [relPath] })).toEqual([`pi --session ${id}`]);
	});
});
