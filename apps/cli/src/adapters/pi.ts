import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { HarnessAdapter, SessionFile, SessionUnit } from "./adapter.js";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SANITIZED_ISO_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const SESSION_PATTERN = new RegExp(`^${SANITIZED_ISO_SOURCE}_(${UUID_SOURCE})\\.jsonl$`, "i");

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readDirectory(path: string): Promise<Dirent[]> {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		throw error;
	}
}

async function statPath(path: string): Promise<Stats | null> {
	try {
		return await stat(path);
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
}

async function enumerateProject(storeRoot: string, projectDirectory: string): Promise<SessionUnit[]> {
	const units: SessionUnit[] = [];
	const entries = (await readDirectory(projectDirectory)).sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (entry.name === ".DS_Store" || !entry.isFile()) {
			continue;
		}
		const match = SESSION_PATTERN.exec(entry.name);
		if (match?.[1] === undefined) {
			continue;
		}
		const absPath = join(projectDirectory, entry.name);
		const stats = await statPath(absPath);
		if (stats === null || !stats.isFile()) {
			continue;
		}
		const file: SessionFile = {
			absPath,
			relPath: relative(storeRoot, absPath),
			role: "main",
			sizeBytes: stats.size,
			mtimeMs: stats.mtimeMs,
		};
		units.push({ id: match[1], files: [file] });
	}
	return units;
}

export const piAdapter: HarnessAdapter = {
	id: "pi",
	displayName: "pi",
	mutationModel: "rewrite-file",
	retentionRisk: null,
	storeRoot(env, home) {
		return env.PI_CODING_AGENT_SESSION_DIR ? env.PI_CODING_AGENT_SESSION_DIR : join(home, ".pi", "agent", "sessions");
	},
	async enumerate(storeRoot) {
		const units: SessionUnit[] = [];
		const projects = (await readDirectory(storeRoot)).sort((left, right) => left.name.localeCompare(right.name));
		for (const project of projects) {
			if (project.name === ".DS_Store" || !project.isDirectory()) {
				continue;
			}
			units.push(...(await enumerateProject(storeRoot, join(storeRoot, project.name))));
		}
		return units.sort((left, right) => left.files[0]!.relPath.localeCompare(right.files[0]!.relPath));
	},
	restoreTarget(storeRoot, relPath) {
		return join(storeRoot, relPath);
	},
	resumeHint(unit) {
		return [`pi --session ${unit.id}`];
	},
};
