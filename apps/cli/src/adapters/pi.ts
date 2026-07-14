import { join, relative } from "node:path";
import { readDirectoryOrEmpty, statOrNull } from "../core/fs.js";
import { type SessionFile, type SessionHarnessAdapter, type SessionUnit, UUID_SOURCE } from "./adapter.js";

const SANITIZED_ISO_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const SESSION_PATTERN = new RegExp(`^${SANITIZED_ISO_SOURCE}_(${UUID_SOURCE})\\.jsonl$`, "i");

async function enumerateDirectory(storeRoot: string, directory: string): Promise<SessionUnit[]> {
	const units: SessionUnit[] = [];
	const entries = (await readDirectoryOrEmpty(directory)).sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (entry.name === ".DS_Store" || !entry.isFile()) {
			continue;
		}
		const match = SESSION_PATTERN.exec(entry.name);
		if (match?.[1] === undefined) {
			continue;
		}
		const absPath = join(directory, entry.name);
		const stats = await statOrNull(absPath);
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

export const piAdapter: SessionHarnessAdapter = {
	id: "pi",
	displayName: "pi",
	mutationModel: "rewrite-file",
	retentionRisk: null,
	storeRoot(env, home) {
		return env.PI_CODING_AGENT_SESSION_DIR ? env.PI_CODING_AGENT_SESSION_DIR : join(home, ".pi", "agent", "sessions");
	},
	async enumerate(storeRoot) {
		const units = await enumerateDirectory(storeRoot, storeRoot);
		const projects = (await readDirectoryOrEmpty(storeRoot)).sort((left, right) => left.name.localeCompare(right.name));
		for (const project of projects) {
			if (project.name === ".DS_Store" || !project.isDirectory()) {
				continue;
			}
			units.push(...(await enumerateDirectory(storeRoot, join(storeRoot, project.name))));
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
