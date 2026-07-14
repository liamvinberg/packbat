import { describe, expect, test } from "vitest";
import { generateSystemdService, generateSystemdTimer } from "./systemd.js";

describe("systemd artifacts", () => {
	test("generates a oneshot service and persistent hourly timer", () => {
		expect(
			generateSystemdService({
				nodePath: "/usr/local/bin/node",
				entryPath: "/home/liam/blotter app/main.js",
				environment: new Map([
					["BLOTTER_HOME", "/home/liam/.blotter"],
					["CLAUDE_CONFIG_DIR", "/home/liam/Claude Code"],
					["CODEX_HOME", "/home/liam/.codex"],
				]),
			}),
		).toBe(`[Unit]
Description=Archive AI agent sessions with blotter

[Service]
Type=oneshot
ExecStart="/usr/local/bin/node" "/home/liam/blotter app/main.js" "sync"
Environment="BLOTTER_HOME=/home/liam/.blotter"
Environment="CLAUDE_CONFIG_DIR=/home/liam/Claude Code"
Environment="CODEX_HOME=/home/liam/.codex"
`);
		expect(generateSystemdTimer()).toBe(`[Unit]
Description=Run blotter sync hourly

[Timer]
OnCalendar=*-*-* *:03:00
Persistent=true
Unit=blotter-sync.service

[Install]
WantedBy=timers.target
`);
	});

	test("omits the service environment when no overrides are set", () => {
		expect(
			generateSystemdService({ nodePath: "/usr/bin/node", entryPath: "/opt/blotter/main.js", environment: new Map() }),
		).toBe(`[Unit]
Description=Archive AI agent sessions with blotter

[Service]
Type=oneshot
ExecStart="/usr/bin/node" "/opt/blotter/main.js" "sync"
`);
	});
});
