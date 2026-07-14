import type { ScheduleEnvironment } from "./environment.js";

export const CRON_MARKER = "# packbat-sync";

export interface CronArtifactOptions {
	nodePath: string;
	entryPath: string;
	environment: ScheduleEnvironment;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`).replaceAll("%", "\\%")}'`;
}

function isPackbatEntry(line: string): boolean {
	return line.trimEnd().endsWith(CRON_MARKER);
}

export function generateCronEntry(options: CronArtifactOptions): string {
	const environment = [...options.environment].map(([key, value]) => `${key}=${shellQuote(value)} `).join("");
	return `3 * * * * ${environment}${shellQuote(options.nodePath)} ${shellQuote(options.entryPath)} ${shellQuote("sync")} ${CRON_MARKER}`;
}

export function stripCronEntry(contents: string): string {
	const hadTrailingNewline = contents.endsWith("\n");
	const lines = contents.split("\n");
	if (hadTrailingNewline) {
		lines.pop();
	}
	const foreignLines = lines.filter((line) => !isPackbatEntry(line));
	if (foreignLines.length === 0) {
		return "";
	}
	return `${foreignLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

export function mergeCronTab(contents: string, entry: string): string {
	const foreign = stripCronEntry(contents);
	const separator = foreign === "" || foreign.endsWith("\n") ? "" : "\n";
	return `${foreign}${separator}${entry}\n`;
}
