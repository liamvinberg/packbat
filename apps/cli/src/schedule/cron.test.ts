import { describe, expect, test } from "vitest";
import { generateCronEntry, mergeCronTab, stripCronEntry } from "./cron.js";

describe("cron artifact", () => {
	test("generates the hourly entry and owns only its marked line", () => {
		const entry = generateCronEntry({
			nodePath: "/usr/local/bin/node",
			entryPath: "/home/liam/packbat app/main.js",
			environment: new Map([
				["PACKBAT_HOME", "/home/liam/.packbat"],
				["CLAUDE_CONFIG_DIR", "/home/liam/Claude Code"],
				["CODEX_HOME", "/home/liam/.codex"],
			]),
		});
		expect(entry).toBe(
			"3 * * * * PACKBAT_HOME='/home/liam/.packbat' CLAUDE_CONFIG_DIR='/home/liam/Claude Code' CODEX_HOME='/home/liam/.codex' '/usr/local/bin/node' '/home/liam/packbat app/main.js' 'sync' # packbat-sync",
		);

		const existing = "MAILTO=liam@example.com\n0 4 * * * /usr/local/bin/backup\n3 * * * * old # packbat-sync\n";
		expect(mergeCronTab(existing, entry)).toBe(
			"MAILTO=liam@example.com\n0 4 * * * /usr/local/bin/backup\n3 * * * * PACKBAT_HOME='/home/liam/.packbat' CLAUDE_CONFIG_DIR='/home/liam/Claude Code' CODEX_HOME='/home/liam/.codex' '/usr/local/bin/node' '/home/liam/packbat app/main.js' 'sync' # packbat-sync\n",
		);
		expect(stripCronEntry(mergeCronTab(existing, entry))).toBe(
			"MAILTO=liam@example.com\n0 4 * * * /usr/local/bin/backup\n",
		);
	});

	test("omits the command environment when no overrides are set", () => {
		expect(
			generateCronEntry({ nodePath: "/usr/bin/node", entryPath: "/opt/packbat/main.js", environment: new Map() }),
		).toBe("3 * * * * '/usr/bin/node' '/opt/packbat/main.js' 'sync' # packbat-sync");
	});
});
