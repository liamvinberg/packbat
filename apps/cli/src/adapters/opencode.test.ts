import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { makeOpenCodeStore } from "../../test/helpers/fixtures.js";
import { openCodeAdapter } from "./opencode.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "blotter-opencode-adapter-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("openCodeAdapter", () => {
	test("resolves absolute and data-root-relative OPENCODE_DB values", () => {
		const home = "/home/liam";
		const xdgDataHome = "/data/liam";
		expect(openCodeAdapter.storeRoot({}, home)).toBe(join(home, ".local", "share", "opencode", "opencode.db"));
		expect(openCodeAdapter.storeRoot({ XDG_DATA_HOME: xdgDataHome }, home)).toBe(
			join(xdgDataHome, "opencode", "opencode.db"),
		);
		expect(openCodeAdapter.storeRoot({ OPENCODE_DB: "/stores/opencode.db" }, home)).toBe("/stores/opencode.db");
		expect(openCodeAdapter.storeRoot({ OPENCODE_DB: "beta.db", XDG_DATA_HOME: xdgDataHome }, home)).toBe(
			join(xdgDataHome, "opencode", "beta.db"),
		);
	});

	test("enumerates one store-wide unit and ignores absent stable and channel databases", async () => {
		const root = await makeRoot();
		const stable = join(root, "opencode.db");
		const channel = join(root, "opencode-beta.db");
		const channelFixture = await makeOpenCodeStore(channel);
		try {
			await expect(openCodeAdapter.enumerate(stable)).resolves.toEqual([]);
			const stableFixture = await makeOpenCodeStore(stable);
			try {
				const units = await openCodeAdapter.enumerate(stable);
				expect(units).toHaveLength(1);
				expect(units[0]).toMatchObject({ sourcePath: stable, sourceSize: expect.any(Number) });
			} finally {
				stableFixture.database.close();
			}
		} finally {
			channelFixture.database.close();
		}
	});

	test("backs up committed WAL frames and validates the completed database", async () => {
		const root = await makeRoot();
		const fixture = await makeOpenCodeStore(join(root, "source.db"), { version: "1.17.5" });
		const destination = join(root, "snapshot.db");
		try {
			const unit = (await openCodeAdapter.enumerate(fixture.databasePath))[0]!;
			const capture = await openCodeAdapter.snapshot(unit, destination);

			expect(capture).toMatchObject({
				contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				sizeBytes: (await readFile(destination)).byteLength,
				softwareVersion: "1.17.5",
				sessions: [{ id: fixture.id }],
			});
			const completed = new DatabaseSync(destination, { readOnly: true });
			try {
				expect(completed.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
				expect(completed.prepare("SELECT id FROM session").get()).toEqual({ id: fixture.id });
			} finally {
				completed.close();
			}
			await expect(openCodeAdapter.validateSnapshot(destination, fixture.id)).resolves.toBeUndefined();
			await expect(openCodeAdapter.validateSnapshot(destination, "ses_missing")).rejects.toThrow(
				"does not contain session",
			);
		} finally {
			fixture.database.close();
		}
	});
});
