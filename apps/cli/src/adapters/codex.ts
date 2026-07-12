import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { HarnessAdapter, SessionFile, SessionUnit } from "./adapter.js";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT_PATTERN = new RegExp(`^rollout-.+-(${UUID_SOURCE})\\.jsonl$`, "i");
const YEAR_PATTERN = /^\d{4}$/;
const MONTH_OR_DAY_PATTERN = /^\d{2}$/;

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

function rolloutId(relPath: string): string | null {
	const segments = relPath.split(sep);
	const filename = segments.at(-1);
	if (filename === undefined) {
		return null;
	}
	const match = ROLLOUT_PATTERN.exec(filename);
	if (match?.[1] === undefined) {
		return null;
	}

	const isArchived = segments.length === 2 && segments[0] === "archived_sessions";
	const isActive =
		segments.length === 5 &&
		segments[0] === "sessions" &&
		YEAR_PATTERN.test(segments[1] ?? "") &&
		MONTH_OR_DAY_PATTERN.test(segments[2] ?? "") &&
		MONTH_OR_DAY_PATTERN.test(segments[3] ?? "");
	return isArchived || isActive ? match[1] : null;
}

async function walkRollouts(storeRoot: string, directory: string): Promise<SessionUnit[]> {
	const units: SessionUnit[] = [];
	const entries = (await readDirectory(directory)).sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (entry.name === ".DS_Store") {
			continue;
		}
		const absPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			units.push(...(await walkRollouts(storeRoot, absPath)));
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const relPath = relative(storeRoot, absPath);
		const id = rolloutId(relPath);
		if (id === null) {
			continue;
		}
		const stats = await statPath(absPath);
		if (stats === null || !stats.isFile()) {
			continue;
		}
		const file: SessionFile = {
			absPath,
			relPath,
			role: "main",
			sizeBytes: stats.size,
			mtimeMs: stats.mtimeMs,
		};
		units.push({ id, files: [file] });
	}
	return units;
}

export const codexAdapter: HarnessAdapter = {
	id: "codex",
	displayName: "Codex",
	mutationModel: "append-file",
	retentionRisk: null,
	storeRoot(env, home) {
		return env.CODEX_HOME ? env.CODEX_HOME : join(home, ".codex");
	},
	async enumerate(storeRoot) {
		const units = [
			...(await walkRollouts(storeRoot, join(storeRoot, "sessions"))),
			...(await walkRollouts(storeRoot, join(storeRoot, "archived_sessions"))),
		];
		return units.sort((left, right) => left.files[0]!.relPath.localeCompare(right.files[0]!.relPath));
	},
	restoreTarget(storeRoot, relPath) {
		return join(storeRoot, relPath);
	},
	resumeHint(unit) {
		const archivedPrefix = `archived_sessions${sep}`;
		if (unit.relPaths.some((relPath) => relPath.startsWith(archivedPrefix))) {
			return [`codex unarchive ${unit.id}`, `codex resume ${unit.id}`];
		}
		return [`codex resume ${unit.id}`];
	},
};
