import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessAdapter, UnsupportedStore } from "./adapter.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { piAdapter } from "./pi.js";

export const adapters: readonly HarnessAdapter[] = [claudeCodeAdapter, codexAdapter, piAdapter];

function existingPath(path: string): string | null {
	return existsSync(path) ? path : null;
}

export const unsupportedStores: readonly UnsupportedStore[] = [
	{
		id: "opencode",
		displayName: "OpenCode",
		mutationModel: "db-snapshot",
		detect(env, home) {
			const defaultDataHome = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, ".local", "share");
			const path = env.OPENCODE_DB ? env.OPENCODE_DB : join(defaultDataHome, "opencode", "opencode.db");
			return existingPath(path);
		},
	},
	{
		id: "gemini",
		displayName: "Gemini CLI",
		mutationModel: "append-file",
		detect(_env, home) {
			return existingPath(join(home, ".gemini", "tmp"));
		},
	},
	{
		id: "cursor",
		displayName: "Cursor CLI",
		mutationModel: "undisclosed",
		detect(_env, home) {
			return existingPath(join(home, ".cursor"));
		},
	},
];

export function getAdapter(id: string): HarnessAdapter | undefined {
	return adapters.find((adapter) => adapter.id === id);
}
