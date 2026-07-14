import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessAdapter, UnsupportedStore } from "./adapter.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { openCodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";

export const adapters: readonly HarnessAdapter[] = [claudeCodeAdapter, codexAdapter, piAdapter, openCodeAdapter];

function existingPath(path: string): string | null {
	return existsSync(path) ? path : null;
}

export const unsupportedStores: readonly UnsupportedStore[] = [
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
