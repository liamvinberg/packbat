import { open } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { readDirectoryOrEmpty, statOrNull } from "../core/fs.js";
import {
	type FileRole,
	type SessionFile,
	type SessionHarnessAdapter,
	type SessionUnit,
	UUID_SOURCE,
} from "./adapter.js";

const MAX_METADATA_BYTES = 64 * 1024;
const SESSION_PATTERN = /^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-([0-9a-f]{8})\.jsonl?$/i;
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const LEGACY_ID_PREFIX_PATTERN = new RegExp(`^\\s*\\{\\s*"sessionId"\\s*:\\s*"(${UUID_SOURCE})"`, "i");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMetadataPrefix(path: string): Promise<{ text: string; complete: boolean } | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
		if (extname(path) === ".jsonl") {
			if (newline < 0 && bytesRead > MAX_METADATA_BYTES) {
				return null;
			}
			return { text: buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8"), complete: true };
		}
		return {
			text: buffer.subarray(0, Math.min(bytesRead, MAX_METADATA_BYTES)).toString("utf8"),
			complete: bytesRead <= MAX_METADATA_BYTES,
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return null;
		}
		throw error;
	} finally {
		await handle?.close();
	}
}

function sessionIdFromMetadata(path: string, metadata: { text: string; complete: boolean }): string | null {
	try {
		const parsed = JSON.parse(metadata.text) as unknown;
		if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || !UUID_PATTERN.test(parsed.sessionId)) {
			return null;
		}
		return parsed.kind === "subagent" ? null : parsed.sessionId;
	} catch {
		if (extname(path) !== ".json" || metadata.complete) {
			return null;
		}
		return LEGACY_ID_PREFIX_PATTERN.exec(metadata.text)?.[1] ?? null;
	}
}

async function toSessionFile(storeRoot: string, absPath: string, role: FileRole): Promise<SessionFile | null> {
	const stats = await statOrNull(absPath);
	if (stats === null || !stats.isFile()) {
		return null;
	}
	return {
		absPath,
		relPath: relative(storeRoot, absPath),
		role,
		sizeBytes: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}

async function enumerateProject(storeRoot: string, projectDirectory: string): Promise<SessionUnit[]> {
	const marker = await toSessionFile(storeRoot, join(projectDirectory, ".project_root"), "sidecar");
	const chatsDirectory = join(projectDirectory, "chats");
	const entries = (await readDirectoryOrEmpty(chatsDirectory)).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	const units = new Map<string, SessionUnit>();
	for (const entry of entries) {
		const match = entry.isFile() ? SESSION_PATTERN.exec(entry.name) : null;
		if (match?.[1] === undefined) {
			continue;
		}
		const absPath = join(chatsDirectory, entry.name);
		const metadata = await readMetadataPrefix(absPath);
		if (metadata === null) {
			continue;
		}
		const id = sessionIdFromMetadata(absPath, metadata);
		if (id === null || id.slice(0, 8).toLowerCase() !== match[1].toLowerCase()) {
			continue;
		}
		const main = await toSessionFile(storeRoot, absPath, "main");
		if (main === null) {
			continue;
		}
		const existing = units.get(id);
		if (existing !== undefined && extname(existing.files[0]!.absPath) === ".jsonl") {
			continue;
		}
		units.set(id, { id, files: marker === null ? [main] : [main, marker] });
	}
	return [...units.values()].sort((left, right) => left.files[0]!.relPath.localeCompare(right.files[0]!.relPath));
}

export const geminiAdapter: SessionHarnessAdapter = {
	id: "gemini",
	displayName: "Gemini CLI",
	mutationModel: "append-file",
	// DRAFT copy
	retentionRisk:
		"Gemini CLI deletes sessions older than general.sessionRetention.maxAge (30 days by default) at startup, including their associated artifacts.",
	storeRoot(env, home) {
		return join(env.GEMINI_CLI_HOME || home, ".gemini", "tmp");
	},
	async enumerate(storeRoot) {
		const units: SessionUnit[] = [];
		const projects = (await readDirectoryOrEmpty(storeRoot)).sort((left, right) => left.name.localeCompare(right.name));
		for (const project of projects) {
			if (!project.isDirectory()) {
				continue;
			}
			units.push(...(await enumerateProject(storeRoot, join(storeRoot, project.name))));
		}
		return units;
	},
	restoreTarget(storeRoot, relPath) {
		return join(storeRoot, relPath);
	},
	resumeHint(unit) {
		// DRAFT copy
		return ["Run from the original project directory:", `gemini --resume ${unit.id}`];
	},
};
