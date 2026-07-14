import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const MACHINE = "resume-proof-machine";
const MODEL = "gpt-5.4-mini";
const COMMAND_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 600_000;
const homes: string[] = [];

interface ProofLayout {
	home: string;
	project: string;
	blotterHome: string;
	archiveRoot: string;
	claudeConfigDir: string;
	codexHome: string;
	piConfigDir: string;
	piSessionDir: string;
	blotterEnv: Record<string, string>;
}

interface CommandResult {
	command: string;
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function realHome(): string {
	const home = process.env.HOME;
	if (home === undefined || home === "") {
		throw new Error("BLOTTER_RESUME_PROOF requires HOME to locate the installed harness credentials");
	}
	return home;
}

function isolatedEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		TMPDIR: process.env.TMPDIR ?? "",
		CI: "1",
		NO_COLOR: "1",
		...extra,
	};
}

async function runCommand(
	command: string,
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, COMMAND_TIMEOUT_MS);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ command, code: code ?? 1, stdout, stderr, timedOut });
		});
	});
}

function expectSuccess(result: CommandResult): void {
	const evidence = [
		`${result.command} exited ${result.code}${result.timedOut ? " after timing out" : ""}`,
		result.stdout === "" ? "" : `stdout:\n${result.stdout}`,
		result.stderr === "" ? "" : `stderr:\n${result.stderr}`,
	]
		.filter(Boolean)
		.join("\n");
	expect(result.timedOut, evidence).toBe(false);
	expect(result.code, evidence).toBe(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLines(output: string): Record<string, unknown>[] {
	return output
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as unknown)
		.filter(isRecord);
}

function codexThreadId(output: string): string {
	for (const event of parseJsonLines(output)) {
		if (event.type === "thread.started" && typeof event.thread_id === "string") {
			return event.thread_id;
		}
	}
	throw new Error(`Codex did not emit a thread.started event:\n${output}`);
}

function piAssistantText(output: string): string {
	let assistantText: string | undefined;
	for (const event of parseJsonLines(output)) {
		if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") {
			continue;
		}
		if (event.message.stopReason !== "stop") {
			const message =
				typeof event.message.errorMessage === "string"
					? event.message.errorMessage
					: "pi assistant turn did not stop cleanly";
			throw new Error(message);
		}
		if (!Array.isArray(event.message.content)) {
			throw new Error("pi assistant message did not contain a content array");
		}
		assistantText = event.message.content
			.filter(isRecord)
			.filter((content) => content.type === "text" && typeof content.text === "string")
			.map((content) => content.text)
			.join("");
	}
	if (assistantText === undefined) {
		throw new Error(`pi did not emit a completed assistant message:\n${output}`);
	}
	return assistantText;
}

async function makeLayout(): Promise<ProofLayout> {
	const home = await makeTempHome();
	homes.push(home);
	const project = join(home, "disposable-project");
	const blotterHome = join(home, "blotter");
	const archiveRoot = join(home, "archive");
	const claudeConfigDir = join(home, "claude");
	const codexHome = join(home, "codex");
	const piConfigDir = join(home, "pi-config");
	const piSessionDir = join(home, "pi-sessions");
	await Promise.all([mkdir(project, { recursive: true }), mkdir(blotterHome, { recursive: true })]);
	await writeFile(
		join(blotterHome, "config.json"),
		`${JSON.stringify({
			version: 1,
			machine: MACHINE,
			archiveRoot,
			sweep: { intervalMinutes: 60 },
			offbox: { mode: "skipped", skippedAt: new Date().toISOString() },
		})}\n`,
	);
	return {
		home,
		project,
		blotterHome,
		archiveRoot,
		claudeConfigDir,
		codexHome,
		piConfigDir,
		piSessionDir,
		blotterEnv: {
			BLOTTER_HOME: blotterHome,
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			CODEX_HOME: codexHome,
			PI_CODING_AGENT_SESSION_DIR: piSessionDir,
		},
	};
}

async function copyCredential(source: string, target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	try {
		await copyFile(source, target);
	} catch (error) {
		throw new Error(`resume proof credential is unavailable at ${source}`, { cause: error });
	}
	await chmod(target, 0o600);
}

async function writePiCredentialFromCodex(target: string): Promise<void> {
	const source = join(realHome(), ".codex", "auth.json");
	const auth = JSON.parse(await readFile(source, "utf8")) as unknown;
	if (!isRecord(auth) || !isRecord(auth.tokens)) {
		throw new Error(`Codex credential has an unsupported shape at ${source}`);
	}
	const access = auth.tokens.access_token;
	const refresh = auth.tokens.refresh_token;
	const accountId = auth.tokens.account_id;
	if (typeof access !== "string" || typeof refresh !== "string" || typeof accountId !== "string") {
		throw new Error(`Codex credential is incomplete at ${source}`);
	}
	const payloadSegment = access.split(".")[1];
	if (payloadSegment === undefined) {
		throw new Error(`Codex access token is not a JWT at ${source}`);
	}
	const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as unknown;
	if (!isRecord(payload) || typeof payload.exp !== "number") {
		throw new Error(`Codex access token has no expiry at ${source}`);
	}
	const expires = payload.exp * 1_000;
	if (expires <= Date.now() + 60_000) {
		throw new Error(`Codex access token expires too soon to run the pi resume proof at ${source}`);
	}
	await mkdir(dirname(target), { recursive: true });
	await writeFile(
		target,
		`${JSON.stringify({
			"openai-codex": { type: "oauth", access, refresh, expires, accountId },
		})}\n`,
		{ mode: 0o600 },
	);
}

async function findFiles(directory: string, matches: (path: string) => boolean): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await findFiles(path, matches)));
		} else if (entry.isFile() && matches(path)) {
			paths.push(path);
		}
	}
	return paths;
}

async function findSessionFile(root: string, id: string): Promise<string> {
	const matches = await findFiles(root, (path) => basename(path).includes(id) && path.endsWith(".jsonl"));
	expect(matches, `expected exactly one session file for ${id} below ${root}`).toHaveLength(1);
	return matches[0]!;
}

async function sync(layout: ProofLayout): Promise<void> {
	const result = await runCli(["sync"], { home: layout.home, env: layout.blotterEnv });
	expect(result.code, result.stderr).toBe(0);
}

async function restore(layout: ProofLayout, id: string): Promise<void> {
	const result = await runCli(["restore", id], { home: layout.home, env: layout.blotterEnv });
	expect(result.code, result.stderr).toBe(0);
	expect(result.stdout).toContain(`restored 1 file`);
}

async function downgradePiSessionToV1(path: string): Promise<Buffer> {
	const entries = parseJsonLines(await readFile(path, "utf8"));
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 1;
		} else {
			delete entry.id;
			delete entry.parentId;
		}
	}
	const bytes = Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	await writeFile(path, bytes);
	return bytes;
}

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe.runIf(process.env.BLOTTER_RESUME_PROOF === "1")("resume proof", () => {
	test(
		"Claude Code: a restored session is discovered from its encoded cwd and resumes with its prior context",
		async () => {
			const layout = await makeLayout();
			const id = randomUUID();
			const codename = `larkspur-claude-${randomUUID()}`;
			await copyCredential(
				join(realHome(), ".claude", ".credentials.json"),
				join(layout.claudeConfigDir, ".credentials.json"),
			);
			const env = isolatedEnv(layout.home, { CLAUDE_CONFIG_DIR: layout.claudeConfigDir });
			const commonArgs = ["--print", "--safe-mode", "--tools", "", "--model", "haiku", "--output-format", "json"];

			const created = await runCommand(
				"claude",
				[
					...commonArgs,
					"--session-id",
					id,
					`For this disposable continuity test, the fictional project codename is ${codename}. Acknowledge it briefly.`,
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(created);
			const originalPath = await findSessionFile(join(layout.claudeConfigDir, "projects"), id);
			const originalBytes = await readFile(originalPath);

			await sync(layout);
			await rm(join(layout.claudeConfigDir, "projects"), { recursive: true, force: true });
			await restore(layout, id);
			const restoredPath = await findSessionFile(join(layout.claudeConfigDir, "projects"), id);
			expect(await readFile(restoredPath)).toEqual(originalBytes);

			const resumed = await runCommand(
				"claude",
				[
					...commonArgs,
					"--resume",
					id,
					"What fictional project codename was provided in my previous message? Reply with only the codename.",
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(resumed);
			expect(resumed.stdout).toContain(codename);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"Codex: an archived-only restore can be unarchived without SQLite and resumes with its prior context",
		async () => {
			const layout = await makeLayout();
			const codename = `larkspur-codex-${randomUUID()}`;
			const authSource = join(realHome(), ".codex", "auth.json");
			const authTarget = join(layout.codexHome, "auth.json");
			await copyCredential(authSource, authTarget);
			const env = isolatedEnv(layout.home, { CODEX_HOME: layout.codexHome });
			const commonArgs = [
				"exec",
				"--ignore-user-config",
				"--ignore-rules",
				"--skip-git-repo-check",
				"--sandbox",
				"read-only",
				"--cd",
				layout.project,
				"--model",
				MODEL,
				"--json",
			];

			const created = await runCommand(
				"codex",
				[
					...commonArgs,
					`For this disposable continuity test, the fictional project codename is ${codename}. Acknowledge it briefly.`,
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(created);
			const id = codexThreadId(created.stdout);

			const archived = await runCommand("codex", ["archive", "--cd", layout.project, id], {
				cwd: layout.project,
				env,
			});
			expectSuccess(archived);
			const originalPath = await findSessionFile(join(layout.codexHome, "archived_sessions"), id);
			const originalBytes = await readFile(originalPath);

			await sync(layout);
			await rm(layout.codexHome, { recursive: true, force: true });
			await copyCredential(authSource, authTarget);
			await restore(layout, id);
			const restoredPath = await findSessionFile(join(layout.codexHome, "archived_sessions"), id);
			expect(await readFile(restoredPath)).toEqual(originalBytes);

			const unarchived = await runCommand("codex", ["unarchive", "--cd", layout.project, id], {
				cwd: layout.project,
				env,
			});
			expectSuccess(unarchived);
			await findSessionFile(join(layout.codexHome, "sessions"), id);

			const resumed = await runCommand(
				"codex",
				[
					...commonArgs,
					"resume",
					id,
					"What fictional project codename was provided in my previous message? Reply with only the codename.",
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(resumed);
			expect(codexThreadId(resumed.stdout)).toBe(id);
			expect(resumed.stdout).toContain(codename);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"pi: a restored v1 session migrates live, resumes, and forks without losing prior context",
		async () => {
			const layout = await makeLayout();
			const id = randomUUID();
			const codename = `larkspur-pi-${randomUUID()}`;
			await writePiCredentialFromCodex(join(layout.piConfigDir, "auth.json"));
			const env = isolatedEnv(layout.home, {
				PI_CODING_AGENT_DIR: layout.piConfigDir,
				PI_CODING_AGENT_SESSION_DIR: layout.piSessionDir,
			});
			const commonArgs = [
				"--print",
				"--provider",
				"openai-codex",
				"--model",
				MODEL,
				"--thinking",
				"off",
				"--no-tools",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-approve",
				"--mode",
				"json",
			];

			const created = await runCommand(
				"pi",
				[
					...commonArgs,
					"--session-id",
					id,
					`For this disposable continuity test, the fictional project codename is ${codename}. Acknowledge it briefly.`,
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(created);
			expect(piAssistantText(created.stdout)).not.toBe("");
			const originalPath = await findSessionFile(layout.piSessionDir, id);
			const v1Bytes = await downgradePiSessionToV1(originalPath);

			await sync(layout);
			const archivedPath = (
				await findFiles(join(layout.archiveRoot, MACHINE, "pi"), (path) => path.endsWith(`${id}.jsonl.zst`))
			)[0];
			expect(archivedPath).toBeDefined();
			const archivedBytes = await readFile(archivedPath!);
			await rm(layout.piSessionDir, { recursive: true, force: true });
			await restore(layout, id);
			const restoredPath = await findSessionFile(layout.piSessionDir, id);
			expect(await readFile(restoredPath)).toEqual(v1Bytes);

			const resumed = await runCommand(
				"pi",
				[
					...commonArgs,
					"--session",
					id,
					"What fictional project codename was provided in my previous message? Reply with only the codename.",
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(resumed);
			expect(piAssistantText(resumed.stdout)).toContain(codename);
			const migratedEntries = parseJsonLines(await readFile(restoredPath, "utf8"));
			expect(migratedEntries[0]?.version).toBe(3);
			for (const entry of migratedEntries.slice(1)) {
				expect(typeof entry.id).toBe("string");
				expect(entry.parentId === null || typeof entry.parentId === "string").toBe(true);
			}

			const forkId = randomUUID();
			const forked = await runCommand(
				"pi",
				[
					...commonArgs,
					"--fork",
					id,
					"--session-id",
					forkId,
					"What fictional project codename was provided before this session was forked? Reply with only the codename.",
				],
				{ cwd: layout.project, env },
			);
			expectSuccess(forked);
			expect(piAssistantText(forked.stdout)).toContain(codename);
			const forkPath = await findSessionFile(layout.piSessionDir, forkId);
			expect(forkPath).not.toBe(restoredPath);
			const forkEntries = parseJsonLines(await readFile(forkPath, "utf8"));
			expect(forkEntries[0]).toMatchObject({
				type: "session",
				version: 3,
				id: forkId,
				parentSession: restoredPath,
			});
			expect(forkEntries.length).toBeGreaterThan(migratedEntries.length);
			expect(await readFile(archivedPath!)).toEqual(archivedBytes);
		},
		TEST_TIMEOUT_MS,
	);
});
