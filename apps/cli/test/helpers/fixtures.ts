import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";
const PI_ID = "33333333-3333-4333-8333-333333333333";
const SYNTHETIC_ISO_TIMESTAMP = "2026-01-02T03:04:05.000Z";
const SANITIZED_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export interface FixtureFile {
	absPath: string;
	relPath: string;
	role: "main" | "sidecar";
}

export interface FixtureUnit {
	id: string;
	files: FixtureFile[];
}

export interface FixtureFileOptions {
	mtimeMs?: number;
}

export interface ClaudeSidecarOptions extends FixtureFileOptions {
	/** Path below the session's same-UUID sidecar directory. */
	relPath: string;
}

export interface ClaudeStoreOptions {
	id?: string;
	encodedCwd?: string;
	main?: FixtureFileOptions | false;
	sidecars?: readonly ClaudeSidecarOptions[];
}

export interface CodexStoreOptions extends FixtureFileOptions {
	id?: string;
	archived?: boolean;
	/** Filename-safe rollout timestamp. */
	timestamp?: string;
}

export interface PiStoreOptions extends FixtureFileOptions {
	id?: string;
	encodedCwd?: string;
	/** Filename-safe ISO timestamp. */
	timestamp?: string;
}

async function setMtime(path: string, mtimeMs: number | undefined): Promise<void> {
	if (mtimeMs === undefined) {
		return;
	}
	const mtime = new Date(mtimeMs);
	await utimes(path, mtime, mtime);
}

async function writeJsonl(path: string, records: readonly unknown[], mtimeMs?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	await setMtime(path, mtimeMs);
}

export async function appendJsonLine(file: FixtureFile | string, record: unknown, mtimeMs?: number): Promise<void> {
	const path = typeof file === "string" ? file : file.absPath;
	await appendFile(path, `${JSON.stringify(record)}\n`);
	await setMtime(path, mtimeMs);
}

export async function makeClaudeStore(root: string, options: ClaudeStoreOptions = {}): Promise<FixtureUnit> {
	const id = options.id ?? CLAUDE_ID;
	const encodedCwd = options.encodedCwd ?? "-synthetic-project";
	const files: FixtureFile[] = [];

	if (options.main !== false) {
		const relPath = join(encodedCwd, `${id}.jsonl`);
		const absPath = join(root, relPath);
		await writeJsonl(
			absPath,
			[
				{
					type: "user",
					uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					parentUuid: null,
					sessionId: id,
					timestamp: SYNTHETIC_ISO_TIMESTAMP,
					cwd: "/synthetic/project",
					gitBranch: "main",
					version: "0.0.0-synthetic",
					userType: "external",
					entrypoint: "cli",
					isSidechain: false,
					message: { role: "user", content: "Synthetic fixture prompt." },
				},
				{
					type: "assistant",
					uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					parentUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					sessionId: id,
					timestamp: "2026-01-02T03:04:06.000Z",
					cwd: "/synthetic/project",
					gitBranch: "main",
					version: "0.0.0-synthetic",
					userType: "external",
					entrypoint: "cli",
					isSidechain: false,
					message: {
						id: "msg_synthetic",
						type: "message",
						role: "assistant",
						model: "synthetic-model",
						content: [{ type: "text", text: "Synthetic fixture response." }],
						stop_reason: "end_turn",
						stop_sequence: null,
					},
				},
			],
			options.main?.mtimeMs,
		);
		files.push({ absPath, relPath, role: "main" });
	}

	const sidecars = options.sidecars ?? [
		{ relPath: join("subagents", "agent-a1b2c3d4.jsonl") },
		{ relPath: join("tool-results", "synthetic-result.txt") },
	];
	for (const sidecar of sidecars) {
		const relPath = join(encodedCwd, id, sidecar.relPath);
		const absPath = join(root, relPath);
		if (extname(absPath) === ".jsonl") {
			await writeJsonl(
				absPath,
				[
					{
						type: "user",
						uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
						parentUuid: null,
						sessionId: id,
						agentId: "a1b2c3d4",
						timestamp: SYNTHETIC_ISO_TIMESTAMP,
						cwd: "/synthetic/project",
						message: { role: "user", content: "Synthetic subagent prompt." },
					},
				],
				sidecar.mtimeMs,
			);
		} else {
			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, "Synthetic tool result.\n");
			await setMtime(absPath, sidecar.mtimeMs);
		}
		files.push({ absPath, relPath, role: "sidecar" });
	}

	return { id, files };
}

export async function makeCodexStore(root: string, options: CodexStoreOptions = {}): Promise<FixtureUnit> {
	const id = options.id ?? CODEX_ID;
	const timestamp = options.timestamp ?? "2026-01-02T03-04-05";
	const dateMatch = /^(\d{4})-(\d{2})-(\d{2})T/.exec(timestamp);
	if (dateMatch === null) {
		throw new Error(`invalid Codex fixture timestamp: ${timestamp}`);
	}
	const filename = `rollout-${timestamp}-${id}.jsonl`;
	const relPath = options.archived
		? join("archived_sessions", filename)
		: join("sessions", dateMatch[1]!, dateMatch[2]!, dateMatch[3]!, filename);
	const absPath = join(root, relPath);
	await writeJsonl(
		absPath,
		[
			{
				timestamp: SYNTHETIC_ISO_TIMESTAMP,
				type: "session_meta",
				payload: {
					id,
					session_id: id,
					timestamp: SYNTHETIC_ISO_TIMESTAMP,
					cwd: "/synthetic/project",
					cli_version: "0.0.0-synthetic",
					source: "cli",
					originator: "blotter-fixture",
					model_provider: "synthetic",
				},
			},
			{
				timestamp: "2026-01-02T03:04:06.000Z",
				type: "turn_context",
				payload: {
					turn_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					cwd: "/synthetic/project",
					current_date: "2026-01-02",
					timezone: "UTC",
					model: "synthetic-model",
					effort: "medium",
				},
			},
		],
		options.mtimeMs,
	);
	return { id, files: [{ absPath, relPath, role: "main" }] };
}

export async function makePiStore(root: string, options: PiStoreOptions = {}): Promise<FixtureUnit> {
	const id = options.id ?? PI_ID;
	const encodedCwd = options.encodedCwd ?? "--synthetic-project--";
	const timestamp = options.timestamp ?? "2026-01-02T03-04-05-000Z";
	if (!SANITIZED_ISO_PATTERN.test(timestamp)) {
		throw new Error(`invalid pi fixture timestamp: ${timestamp}`);
	}
	const relPath = join(encodedCwd, `${timestamp}_${id}.jsonl`);
	const absPath = join(root, relPath);
	await writeJsonl(
		absPath,
		[
			{
				type: "session",
				version: 3,
				id,
				timestamp: SYNTHETIC_ISO_TIMESTAMP,
				cwd: "/synthetic/project",
			},
			{
				type: "message",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: "2026-01-02T03:04:06.000Z",
				message: { role: "user", content: "Synthetic fixture prompt." },
			},
		],
		options.mtimeMs,
	);
	return { id, files: [{ absPath, relPath, role: "main" }] };
}
