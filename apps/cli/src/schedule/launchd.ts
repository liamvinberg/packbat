import { join } from "node:path";
import type { ScheduleEnvironment } from "./environment.js";

export const LAUNCHD_LABEL = "com.blotter.sync";

export interface LaunchdArtifactOptions {
	nodePath: string;
	entryPath: string;
	logsPath: string;
	environment: ScheduleEnvironment;
}

function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function generateLaunchdPlist(options: LaunchdArtifactOptions): string {
	const environment =
		options.environment.size === 0
			? ""
			: `\t<key>EnvironmentVariables</key>\n\t<dict>\n${[...options.environment]
					.map(([key, value]) => `\t\t<key>${escapeXmlText(key)}</key>\n\t\t<string>${escapeXmlText(value)}</string>\n`)
					.join("")}\t</dict>\n`;
	const logPath = escapeXmlText(join(options.logsPath, "launchd.log"));
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXmlText(options.nodePath)}</string>
		<string>${escapeXmlText(options.entryPath)}</string>
		<string>sync</string>
	</array>
${environment}	<key>StartCalendarInterval</key>
	<dict>
		<key>Minute</key>
		<integer>3</integer>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${logPath}</string>
	<key>StandardErrorPath</key>
	<string>${logPath}</string>
</dict>
</plist>
`;
}
