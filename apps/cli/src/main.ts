import { readFileSync } from "node:fs";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runRestore } from "./commands/restore.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
import { BlotterError } from "./core/errors.js";

const HELP = `blotter — every agent session, kept.

Usage: blotter <command> [options]

Commands:
  init      set up archiving: detect harnesses, schedule the sweep, off-box or skip
  sync      run one sweep now (the scheduled job runs this)
  doctor    prove the schedule is alive and nothing is being missed
  restore   put an archived session back where its harness resumes it
  status    one-screen health summary

Options:
  -h, --help     show this help
  -v, --version  show version

Run \`blotter <command> --help\` for command options.
`;

const commands: Record<string, (argv: string[]) => Promise<number>> = {
	init: runInit,
	sync: runSync,
	doctor: runDoctor,
	restore: runRestore,
	status: runStatus,
};

function version(): string {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	return pkg.version;
}

async function main(argv: string[]): Promise<number> {
	const [first, ...rest] = argv;
	if (first === undefined || first === "--help" || first === "-h") {
		process.stdout.write(HELP);
		return first === undefined ? 1 : 0;
	}
	if (first === "--version" || first === "-v") {
		process.stdout.write(`${version()}\n`);
		return 0;
	}
	const command = commands[first];
	if (command === undefined) {
		process.stderr.write(`blotter: unknown command "${first}"\n\n${HELP}`);
		return 1;
	}
	return command(rest);
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		if (error instanceof BlotterError) {
			process.stderr.write(`blotter: ${error.message}\n`);
		} else {
			process.stderr.write(
				`blotter: unexpected error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
		}
		process.exitCode = 1;
	},
);
