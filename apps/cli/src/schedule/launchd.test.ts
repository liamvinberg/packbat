import { describe, expect, test } from "vitest";
import { generateLaunchdPlist } from "./launchd.js";

describe("generateLaunchdPlist", () => {
	test("generates the hourly user agent with ordered environment overrides", () => {
		expect(
			generateLaunchdPlist({
				nodePath: "/opt/node/bin/node",
				entryPath: "/Users/liam/Library/Application Support/blotter/main.js",
				logsPath: "/Users/liam/.blotter/logs",
				environment: new Map([
					["BLOTTER_HOME", "/Users/liam/.blotter"],
					["CLAUDE_CONFIG_DIR", "/Users/liam/Library/Application Support/Claude"],
					["CODEX_HOME", "/Users/liam/.codex"],
				]),
			}),
		).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.blotter.sync</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/node/bin/node</string>
		<string>/Users/liam/Library/Application Support/blotter/main.js</string>
		<string>sync</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>BLOTTER_HOME</key>
		<string>/Users/liam/.blotter</string>
		<key>CLAUDE_CONFIG_DIR</key>
		<string>/Users/liam/Library/Application Support/Claude</string>
		<key>CODEX_HOME</key>
		<string>/Users/liam/.codex</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Minute</key>
		<integer>3</integer>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>/Users/liam/.blotter/logs/launchd.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/liam/.blotter/logs/launchd.log</string>
</dict>
</plist>
`);
	});

	test("omits the environment dictionary when no overrides are set", () => {
		const plist = generateLaunchdPlist({
			nodePath: "/opt/node/bin/node",
			entryPath: "/opt/blotter/main.js",
			logsPath: "/home/liam/.blotter/logs",
			environment: new Map(),
		});
		expect(plist).not.toContain("EnvironmentVariables");
		expect(plist).not.toContain("BLOTTER_HOME");
	});
});
