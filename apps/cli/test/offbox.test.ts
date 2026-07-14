import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { decryptWithIdentity, encryptToRecipient, generateIdentity, identityToRecipient } from "../src/offbox/age.js";
import { renderRecoveryKit } from "../src/offbox/recovery-kit.js";
import { appendJsonLine, makeClaudeStore } from "./helpers/fixtures.js";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const SOURCE_MTIME_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const hasRclone = spawnSync("rclone", ["version"], { stdio: "ignore" }).status === 0;
const hasWellKnownRclone = ["/opt/homebrew/bin/rclone", "/usr/local/bin/rclone", "/usr/bin/rclone"].some(
	(path) => spawnSync(path, ["version"], { stdio: "ignore" }).status === 0,
);
const hasAgeBinary = spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0;
const homes: string[] = [];

interface Layout {
	home: string;
	blotterHome: string;
	archiveRoot: string;
	claudeRoot: string;
	remote: string;
	env: Record<string, string>;
}

async function makeLayout(): Promise<Layout> {
	const home = await makeTempHome();
	homes.push(home);
	const blotterHome = join(home, "blotter");
	const claudeConfigDir = join(home, "stores", "claude");
	return {
		home,
		blotterHome,
		archiveRoot: join(home, "archive"),
		claudeRoot: join(claudeConfigDir, "projects"),
		remote: join(home, "remote"),
		env: {
			BLOTTER_HOME: blotterHome,
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			CODEX_HOME: join(home, "stores", "codex"),
			PI_CODING_AGENT_SESSION_DIR: join(home, "stores", "pi"),
		},
	};
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile()) {
				files.push(relative(root, child));
			}
		}
	}
	await walk(root);
	return files.sort((left, right) => left.localeCompare(right));
}

async function matchingLineCount(path: string, text: string): Promise<number> {
	return (await readFile(path, "utf8")).split("\n").filter((line) => line.includes(text)).length;
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("off-box configuration", () => {
	test("requires both remote flags for non-interactive setup", async () => {
		const layout = await makeLayout();
		const missingRecipient = await runCli(
			["init", "--yes", "--offbox", "remote", "--offbox-remote", layout.remote, "--no-activate"],
			{ home: layout.home, env: layout.env },
		);
		expect(missingRecipient.code).toBe(1);
		expect(missingRecipient.stderr).toContain("--offbox remote requires --age-recipient");

		const missingRemote = await runCli(
			["init", "--yes", "--offbox", "remote", "--age-recipient", "age1synthetic", "--no-activate"],
			{ home: layout.home, env: layout.env },
		);
		expect(missingRemote.code).toBe(1);
		expect(missingRemote.stderr).toContain("--offbox remote requires --offbox-remote");
	});

	test.skipIf(hasWellKnownRclone)(
		"keeps local success true and reports an off-box failure when rclone is absent",
		async () => {
			const layout = await makeLayout();
			const identity = await generateIdentity();
			const recipient = await identityToRecipient(identity);
			await makeClaudeStore(layout.claudeRoot, { main: { mtimeMs: SOURCE_MTIME_MS }, sidecars: [] });
			await writeFile(
				join(layout.home, "config.json"),
				`${JSON.stringify({
					version: 1,
					machine: "test-machine",
					archiveRoot: layout.archiveRoot,
					sweep: { intervalMinutes: 60 },
					offbox: {
						mode: "configured",
						recipient,
						remote: { destination: layout.remote, rcloneConfig: "default" },
					},
				})}\n`,
			);

			const result = await runCli(["sync"], {
				home: layout.home,
				env: { ...layout.env, BLOTTER_HOME: layout.home, PATH: "" },
			});

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("rclone was not found on PATH");
			expect(result.stderr).toContain("brew install rclone");
			expect(result.stderr).toContain("apt install rclone");
			const stamp = JSON.parse(await readFile(join(layout.home, "state", "last-run.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(stamp).toMatchObject({ ok: true, archived: 1, offbox: expect.stringContaining("rclone") });
			expect(JSON.parse(await readFile(join(layout.home, "state", "last-success.json"), "utf8"))).toEqual(stamp);
			expect(await readFile(join(layout.home, "logs", "blotter.log"), "utf8")).toContain("off-box failed");
			expect((await listFiles(join(layout.home, "state", "outbox"))).some((path) => path.endsWith(".age"))).toBe(true);
		},
	);

	test("logs the skipped off-box risk at most once per week and never to stdout", async () => {
		const layout = await makeLayout();
		await writeFile(
			join(layout.home, "config.json"),
			`${JSON.stringify({
				version: 1,
				machine: "test-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: { mode: "skipped", skippedAt: "2026-01-02T03:04:05.000Z" },
			})}\n`,
		);

		const first = await runCli(["sync"], { home: layout.home, env: { ...layout.env, BLOTTER_HOME: layout.home } });
		const second = await runCli(["sync"], { home: layout.home, env: { ...layout.env, BLOTTER_HOME: layout.home } });

		const risk = "If this laptop dies, sessions not copied off-box die with it.";
		expect(first.stdout).not.toContain(risk);
		expect(second.stdout).not.toContain(risk);
		expect(await matchingLineCount(join(layout.home, "logs", "blotter.log"), risk)).toBe(1);
		expect(JSON.parse(await readFile(join(layout.home, "state", "offbox-reminder.json"), "utf8"))).toMatchObject({
			remindedAt: expect.any(String),
		});
	});
});

describe.skipIf(!hasAgeBinary)("age CLI interoperability", () => {
	test("decrypts library ciphertext with the age binary", async () => {
		const layout = await makeLayout();
		const identity = await generateIdentity();
		const recipient = await identityToRecipient(identity);
		const plaintext = Buffer.from("interoperable synthetic bytes\n");
		const identityPath = join(layout.home, "identity.txt");
		const ciphertextPath = join(layout.home, "archive.age");
		await writeFile(identityPath, `${identity}\n`);
		await writeFile(ciphertextPath, await encryptToRecipient(recipient, plaintext));

		const restored = execFileSync("age", ["-d", "-i", identityPath, ciphertextPath]);

		expect(restored).toEqual(plaintext);
	});
});

describe.skipIf(!hasRclone)("off-box archive cycle", () => {
	test("refuses a fresh install that would overwrite another machine archive", async () => {
		const first = await makeLayout();
		const second = await makeLayout();
		const identity = await generateIdentity();
		const recipient = await identityToRecipient(identity);
		await makeClaudeStore(first.claudeRoot, { main: { mtimeMs: SOURCE_MTIME_MS }, sidecars: [] });
		await makeClaudeStore(second.claudeRoot, { main: { mtimeMs: SOURCE_MTIME_MS }, sidecars: [] });
		const configured = (layout: Layout, machine: string) =>
			JSON.stringify({
				version: 1,
				machine,
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: {
					mode: "configured",
					recipient,
					remote: { destination: first.remote, rcloneConfig: "default" },
				},
			});
		await Promise.all([mkdir(first.blotterHome, { recursive: true }), mkdir(second.blotterHome, { recursive: true })]);
		await writeFile(join(first.blotterHome, "config.json"), `${configured(first, "shared-machine")}\n`);
		expect((await runCli(["sync"], { home: first.home, env: first.env })).code).toBe(0);
		const remoteIndexPath = join(first.remote, "shared-machine", "index.jsonl.age");
		const originalRemoteIndex = await readFile(remoteIndexPath);

		await writeFile(join(second.blotterHome, "config.json"), `${configured(second, "shared-machine")}\n`);
		const refused = await runCli(["sync"], { home: second.home, env: second.env });

		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(
			"an archive for machine `shared-machine` already exists at the remote; restore it first (`blotter restore --from-remote --identity <kit-file>`) or change `machine` in config.json.",
		);
		expect(await readFile(remoteIndexPath)).toEqual(originalRemoteIndex);

		await writeFile(join(second.blotterHome, "config.json"), `${configured(second, "second-machine")}\n`);
		const separated = await runCli(["sync"], { home: second.home, env: second.env });
		expect(separated.code).toBe(0);
		expect(await stat(join(first.remote, "second-machine", "index.jsonl.age"))).toBeDefined();
	});

	test("touches and uses the blotter-owned config in managed mode", async () => {
		const layout = await makeLayout();
		const identity = await generateIdentity();
		const recipient = await identityToRecipient(identity);

		const initialized = await runCli(
			[
				"init",
				"--yes",
				"--archive-root",
				layout.archiveRoot,
				"--offbox",
				"remote",
				"--offbox-remote",
				layout.remote,
				"--age-recipient",
				recipient,
				"--rclone-config",
				"managed",
				"--no-activate",
			],
			{ home: layout.home, env: layout.env },
		);

		expect(initialized.code).toBe(0);
		const managedConfigPath = join(layout.blotterHome, "rclone.conf");
		expect(await readFile(managedConfigPath, "utf8")).toBe("");
		expect((await stat(managedConfigPath)).mode & 0o777).toBe(0o600);
		const config = JSON.parse(await readFile(join(layout.blotterHome, "config.json"), "utf8")) as {
			machine: string;
		};
		const index = await decryptWithIdentity(
			identity,
			await readFile(join(layout.remote, config.machine, "index.jsonl.age")),
		);
		expect(index.toString("utf8")).toBe("");
	});

	test("reuploads unchanged data after the rclone mode, destination, or recipient changes", async () => {
		const layout = await makeLayout();
		const firstIdentity = await generateIdentity();
		const firstRecipient = await identityToRecipient(firstIdentity);
		await makeClaudeStore(layout.claudeRoot, { main: { mtimeMs: SOURCE_MTIME_MS }, sidecars: [] });
		const initArguments = (destination: string, recipient: string, rcloneConfig: "default" | "managed" = "default") => [
			"init",
			"--yes",
			"--archive-root",
			layout.archiveRoot,
			"--offbox",
			"remote",
			"--offbox-remote",
			destination,
			"--age-recipient",
			recipient,
			"--rclone-config",
			rcloneConfig,
			"--no-activate",
		];

		expect(
			(await runCli(initArguments(layout.remote, firstRecipient), { home: layout.home, env: layout.env })).code,
		).toBe(0);
		expect(
			(await runCli(initArguments(layout.remote, firstRecipient, "managed"), { home: layout.home, env: layout.env }))
				.code,
		).toBe(0);
		expect(
			JSON.parse(await readFile(join(layout.blotterHome, "state", "offbox-last-success.json"), "utf8")),
		).toMatchObject({ uploaded: 1 });
		const secondRemote = join(layout.home, "second-remote");
		expect(
			(await runCli(initArguments(secondRemote, firstRecipient), { home: layout.home, env: layout.env })).code,
		).toBe(0);
		expect(
			JSON.parse(await readFile(join(layout.blotterHome, "state", "offbox-last-success.json"), "utf8")),
		).toMatchObject({ uploaded: 1 });

		const secondIdentity = await generateIdentity();
		const secondRecipient = await identityToRecipient(secondIdentity);
		expect(
			(await runCli(initArguments(secondRemote, secondRecipient), { home: layout.home, env: layout.env })).code,
		).toBe(0);
		expect(
			JSON.parse(await readFile(join(layout.blotterHome, "state", "offbox-last-success.json"), "utf8")),
		).toMatchObject({ uploaded: 1 });
		const config = JSON.parse(await readFile(join(layout.blotterHome, "config.json"), "utf8")) as {
			machine: string;
		};
		const index = (
			await decryptWithIdentity(secondIdentity, await readFile(join(secondRemote, config.machine, "index.jsonl.age")))
		).toString("utf8");
		const record = JSON.parse(index.trim()) as { path: string };
		const ciphertext = await readFile(join(secondRemote, config.machine, `${record.path}.age`));
		expect(await decryptWithIdentity(secondIdentity, ciphertext)).toEqual(
			await readFile(join(layout.archiveRoot, config.machine, record.path)),
		);
	});

	test("uploads only changed ciphertext and restores byte-identical sessions from a recovery kit", async () => {
		const layout = await makeLayout();
		const identity = await generateIdentity();
		const recipient = await identityToRecipient(identity);
		const fixture = await makeClaudeStore(layout.claudeRoot, {
			main: { mtimeMs: SOURCE_MTIME_MS },
			sidecars: [{ relPath: join("subagents", "agent-a1b2c3d4.jsonl"), mtimeMs: SOURCE_MTIME_MS }],
		});

		const initialized = await runCli(
			[
				"init",
				"--yes",
				"--archive-root",
				layout.archiveRoot,
				"--offbox",
				"remote",
				"--offbox-remote",
				layout.remote,
				"--age-recipient",
				recipient,
				"--rclone-config",
				"default",
				"--no-activate",
			],
			{ home: layout.home, env: layout.env },
		);
		expect(initialized.code).toBe(0);
		expect(initialized.stderr).toBe("");

		const config = JSON.parse(await readFile(join(layout.blotterHome, "config.json"), "utf8")) as {
			machine: string;
			offbox: unknown;
		};
		expect(config.offbox).toEqual({
			mode: "configured",
			recipient,
			remote: { destination: layout.remote, rcloneConfig: "default" },
		});
		const encryptedIndexPath = join(layout.remote, config.machine, "index.jsonl.age");
		const index = (await decryptWithIdentity(identity, await readFile(encryptedIndexPath))).toString("utf8");
		const records = index
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { path: string; unit: string });
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.unit === fixture.id)).toBe(true);
		const expectedRemoteFiles = [
			...records.map((record) => join(config.machine, `${record.path}.age`)),
			join(config.machine, "index.jsonl.age"),
		].sort((left, right) => left.localeCompare(right));
		expect(await listFiles(layout.remote)).toEqual(expectedRemoteFiles);
		const remoteMarker = join(layout.remote, "keep-existing.txt");
		await writeFile(remoteMarker, "copy must not delete this\n");

		const dataPaths = records.map((record) => join(layout.remote, config.machine, `${record.path}.age`));
		const firstCiphertexts = await Promise.all(dataPaths.map(async (path) => await readFile(path)));
		const uploadedPath = join(layout.blotterHome, "state", "offbox-uploaded.jsonl");
		const firstUploadedState = await readFile(uploadedPath, "utf8");

		const second = await runCli(["sync"], { home: layout.home, env: layout.env });
		expect(second.code).toBe(0);
		expect(await readFile(uploadedPath, "utf8")).toBe(firstUploadedState);
		expect(
			JSON.parse(await readFile(join(layout.blotterHome, "state", "offbox-last-success.json"), "utf8")),
		).toMatchObject({ uploaded: 0, bytes: 0 });
		for (const [index, path] of dataPaths.entries()) {
			expect(await readFile(path)).toEqual(firstCiphertexts[index]);
		}
		expect(await readFile(remoteMarker, "utf8")).toBe("copy must not delete this\n");

		const grownMtimeMs = SOURCE_MTIME_MS + 60_000;
		await appendJsonLine(fixture.files[0]!, { type: "synthetic-growth", sessionId: fixture.id }, grownMtimeMs);
		const expectedLive = await Promise.all(
			fixture.files.map(async (file) => ({
				path: file.absPath,
				bytes: await readFile(file.absPath),
				mtimeMs: (await stat(file.absPath)).mtimeMs,
			})),
		);

		const grown = await runCli(["sync"], { home: layout.home, env: layout.env });
		expect(grown.code).toBe(0);
		expect(grown.stdout).toContain("archived 1, unchanged 1, failed 0");
		expect(
			JSON.parse(await readFile(join(layout.blotterHome, "state", "offbox-last-success.json"), "utf8")),
		).toMatchObject({ uploaded: 1, bytes: expect.any(Number) });
		expect((await readFile(uploadedPath, "utf8")).trim().split("\n")).toHaveLength(3);
		expect(await readFile(dataPaths[0]!)).not.toEqual(firstCiphertexts[0]);
		expect(await readFile(dataPaths[1]!)).toEqual(firstCiphertexts[1]);
		expect(await readFile(remoteMarker, "utf8")).toBe("copy must not delete this\n");

		for (const path of await listFiles(layout.blotterHome)) {
			expect((await readFile(join(layout.blotterHome, path))).includes("AGE-SECRET-KEY")).toBe(false);
		}

		const kitPath = join(layout.home, "blotter-recovery-kit.txt");
		await writeFile(
			kitPath,
			renderRecoveryKit({
				identity,
				recipient,
				remote: { type: "rclone", destination: layout.remote },
				createdAt: "2026-07-13T10:11:12.000Z",
			}),
		);
		await Promise.all([
			rm(layout.claudeRoot, { recursive: true, force: true }),
			rm(layout.archiveRoot, { recursive: true, force: true }),
		]);

		const restored = await runCli(["restore", "--from-remote", "--identity", kitPath, fixture.id], {
			home: layout.home,
			env: layout.env,
		});
		expect(restored.code).toBe(0);
		expect(restored.stderr).toBe("");
		expect(restored.stdout).toContain(`claude --resume ${fixture.id}`);
		for (const expected of expectedLive) {
			expect(await readFile(expected.path)).toEqual(expected.bytes);
			expect((await stat(expected.path)).mtimeMs).toBe(expected.mtimeMs);
		}

		await appendJsonLine(fixture.files[0]!, { type: "newer-live" }, grownMtimeMs + 60_000);
		const refused = await runCli(["restore", "--from-remote", "--identity", kitPath, fixture.id], {
			home: layout.home,
			env: layout.env,
		});
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("restore would overwrite newer live files");

		const forced = await runCli(["restore", "--from-remote", "--identity", kitPath, "--force", fixture.id], {
			home: layout.home,
			env: layout.env,
		});
		expect(forced.code).toBe(0);
		for (const expected of expectedLive) {
			expect(await readFile(expected.path)).toEqual(expected.bytes);
			expect((await stat(expected.path)).mtimeMs).toBe(expected.mtimeMs);
		}
	});
});
