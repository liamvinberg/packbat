import type { ScheduleEnvironment } from "./environment.js";

export interface SystemdServiceOptions {
	nodePath: string;
	entryPath: string;
	environment: ScheduleEnvironment;
}

function quoteSystemdValue(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n")}"`;
}

export function generateSystemdService(options: SystemdServiceOptions): string {
	const environment = [...options.environment]
		.map(([key, value]) => `Environment=${quoteSystemdValue(`${key}=${value}`)}\n`)
		.join("");
	return `[Unit]
Description=Archive AI agent sessions with Packbat

[Service]
Type=oneshot
ExecStart=${quoteSystemdValue(options.nodePath)} ${quoteSystemdValue(options.entryPath)} ${quoteSystemdValue("sync")}
${environment}`;
}

export function generateSystemdTimer(): string {
	return `[Unit]
Description=Run Packbat sync hourly

[Timer]
OnCalendar=*-*-* *:03:00
Persistent=true
Unit=packbat-sync.service

[Install]
WantedBy=timers.target
`;
}
