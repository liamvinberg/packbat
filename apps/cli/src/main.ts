import { readFileSync } from "node:fs";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runRestore } from "./commands/restore.js";
import { runSearch } from "./commands/search.js";
import { runShow } from "./commands/show.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
import { PackbatError } from "./core/errors.js";

// DRAFT copy. The command block is pinned byte-for-byte by the retrieval contract.
const HELP = `Packbat — every agent session, kept.

Usage: packbat <command> [options]

Commands:
  init      set up archiving: detect harnesses, schedule the sweep, off-box or skip
  sync      run one sweep now (the scheduled job runs this)
  doctor    prove the schedule is alive and nothing is being missed
  restore   put an archived session back where its harness resumes it
  status    one-screen health summary
  search    find text across archived sessions
  show      read one archived session

Options:
  -h, --help     show this help
  -v, --version  show version

Run \`packbat <command> --help\` for command options.
`;

const commands: Record<string, (argv: string[]) => Promise<number>> = {
	init: runInit,
	sync: runSync,
	doctor: runDoctor,
	restore: runRestore,
	status: runStatus,
	search: runSearch,
	show: runShow,
};

function version(): string {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	return pkg.version;
}

// Piping into `head` (or any consumer that closes early) must end the process
// quietly, not crash it.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") {
			process.exit(0);
		}
		throw error;
	});
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
		process.stderr.write(`packbat: unknown command "${first}"\n\n${HELP}`);
		return 1;
	}
	return command(rest);
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		if (error instanceof PackbatError) {
			process.stderr.write(`packbat: ${error.message}\n`);
		} else {
			process.stderr.write(
				`packbat: unexpected error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
		}
		process.exitCode = 1;
	},
);
