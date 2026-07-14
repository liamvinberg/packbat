import { join, relative } from "node:path";
import { readDirectoryOrEmpty, statOrNull } from "../core/fs.js";
import { type FileRole, type HarnessAdapter, type SessionFile, type SessionUnit, UUID_SOURCE } from "./adapter.js";

const TRANSCRIPT_PATTERN = new RegExp(`^(${UUID_SOURCE})\\.jsonl$`, "i");
const SIDECAR_DIRECTORY_PATTERN = new RegExp(`^(${UUID_SOURCE})$`, "i");

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

async function walkSidecars(storeRoot: string, directory: string): Promise<SessionFile[]> {
	const files: SessionFile[] = [];
	const entries = (await readDirectoryOrEmpty(directory)).sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (entry.name === ".DS_Store") {
			continue;
		}
		const absPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkSidecars(storeRoot, absPath)));
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const file = await toSessionFile(storeRoot, absPath, "sidecar");
		if (file !== null) {
			files.push(file);
		}
	}
	return files;
}

async function enumerateProject(storeRoot: string, projectDirectory: string): Promise<SessionUnit[]> {
	const units = new Map<string, SessionUnit>();
	const entries = (await readDirectoryOrEmpty(projectDirectory)).sort((left, right) =>
		left.name.localeCompare(right.name),
	);

	for (const entry of entries) {
		if (entry.name === ".DS_Store") {
			continue;
		}
		const absPath = join(projectDirectory, entry.name);
		if (entry.isFile()) {
			const match = TRANSCRIPT_PATTERN.exec(entry.name);
			if (match?.[1] === undefined) {
				continue;
			}
			const file = await toSessionFile(storeRoot, absPath, "main");
			if (file !== null) {
				units.set(match[1], { id: match[1], files: [file, ...(units.get(match[1])?.files ?? [])] });
			}
			continue;
		}
		if (!entry.isDirectory()) {
			continue;
		}
		const match = SIDECAR_DIRECTORY_PATTERN.exec(entry.name);
		if (match?.[1] === undefined) {
			continue;
		}
		const sidecars = await walkSidecars(storeRoot, absPath);
		if (sidecars.length > 0) {
			const existing = units.get(match[1]);
			units.set(match[1], { id: match[1], files: [...(existing?.files ?? []), ...sidecars] });
		}
	}

	return [...units.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export const claudeCodeAdapter: HarnessAdapter = {
	id: "claude-code",
	displayName: "Claude Code",
	mutationModel: "append-file",
	retentionRisk: "Claude Code deletes sessions older than cleanupPeriodDays (30 days by default) at startup.",
	storeRoot(env, home) {
		const configRoot = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
		return join(configRoot, "projects");
	},
	async enumerate(storeRoot) {
		const units: SessionUnit[] = [];
		const projects = (await readDirectoryOrEmpty(storeRoot)).sort((left, right) => left.name.localeCompare(right.name));
		for (const project of projects) {
			if (project.name === ".DS_Store" || !project.isDirectory()) {
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
		return ["Run from the original project directory:", `claude --resume ${unit.id}`];
	},
};
