import { describe, expect, test } from "vitest";
import { generateSystemdService, generateSystemdTimer } from "./systemd.js";

describe("systemd artifacts", () => {
	test("generates a oneshot service and persistent hourly timer", () => {
		expect(
			generateSystemdService({
				nodePath: "/usr/local/bin/node",
				entryPath: "/home/liam/packbat app/main.js",
				environment: new Map([
					["PACKBAT_HOME", "/home/liam/.packbat"],
					["CLAUDE_CONFIG_DIR", "/home/liam/Claude Code"],
					["CODEX_HOME", "/home/liam/.codex"],
				]),
			}),
		).toBe(`[Unit]
Description=Archive AI agent sessions with Packbat

[Service]
Type=oneshot
ExecStart="/usr/local/bin/node" "/home/liam/packbat app/main.js" "sync"
Environment="PACKBAT_HOME=/home/liam/.packbat"
Environment="CLAUDE_CONFIG_DIR=/home/liam/Claude Code"
Environment="CODEX_HOME=/home/liam/.codex"
`);
		expect(generateSystemdTimer()).toBe(`[Unit]
Description=Run Packbat sync hourly

[Timer]
OnCalendar=*-*-* *:03:00
Persistent=true
Unit=packbat-sync.service

[Install]
WantedBy=timers.target
`);
	});

	test("omits the service environment when no overrides are set", () => {
		expect(
			generateSystemdService({ nodePath: "/usr/bin/node", entryPath: "/opt/packbat/main.js", environment: new Map() }),
		).toBe(`[Unit]
Description=Archive AI agent sessions with Packbat

[Service]
Type=oneshot
ExecStart="/usr/bin/node" "/opt/packbat/main.js" "sync"
`);
	});
});
