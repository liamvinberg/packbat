import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import {
	type ArchivedUnit,
	type RestoreResult,
	readArchivedUnits,
	resolveArchivedUnit,
	restoreArchivedUnit,
} from "../core/restore.js";
import { restoreFromRemote } from "../offbox/remote-restore.js";

const USAGE =
	"Usage: packbat restore [--machine <name>] [--force] [--from-remote --identity <file> [--remote <destination>]] [<id-or-prefix>]\n"; // DRAFT copy
const MACHINE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface RestoreOptions {
	machine?: string;
	force: boolean;
	fromRemote: boolean;
	identityPath?: string;
	remoteDestination?: string;
	prefix?: string;
}

function usageError(message: string): null {
	process.stderr.write(`packbat restore: ${message}\n\n${USAGE}`);
	return null;
}

function parseOptions(argv: string[]): RestoreOptions | null {
	const options: RestoreOptions = { force: false, fromRemote: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--machine": {
				if (options.machine !== undefined) {
					return usageError("--machine may only be passed once");
				}
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) {
					return usageError("--machine requires a name");
				}
				if (!MACHINE_PATTERN.test(value)) {
					return usageError("--machine must be lowercase and hostname-safe (a-z, 0-9, -)");
				}
				options.machine = value;
				index += 1;
				break;
			}
			case "--force":
				if (options.force) {
					return usageError("--force may only be passed once");
				}
				options.force = true;
				break;
			case "--from-remote":
				if (options.fromRemote) {
					return usageError("--from-remote may only be passed once");
				}
				options.fromRemote = true;
				break;
			case "--identity": {
				if (options.identityPath !== undefined) {
					return usageError("--identity may only be passed once");
				}
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) {
					return usageError("--identity requires a file");
				}
				options.identityPath = value;
				index += 1;
				break;
			}
			case "--remote": {
				if (options.remoteDestination !== undefined) {
					return usageError("--remote may only be passed once"); // DRAFT copy
				}
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) {
					return usageError("--remote requires a destination"); // DRAFT copy
				}
				options.remoteDestination = value;
				index += 1;
				break;
			}
			default:
				if (argument === undefined) {
					return usageError("missing argument");
				}
				if (argument.startsWith("-")) {
					return usageError(`unknown option ${argument}`);
				}
				if (options.prefix !== undefined) {
					return usageError("only one id or prefix may be passed");
				}
				options.prefix = argument;
		}
	}
	if (options.force && options.prefix === undefined) {
		return usageError("--force requires an id or prefix");
	}
	if (options.fromRemote && options.identityPath === undefined) {
		return usageError("--from-remote requires --identity <file>");
	}
	if (!options.fromRemote && options.identityPath !== undefined) {
		return usageError("--identity requires --from-remote");
	}
	if (!options.fromRemote && options.remoteDestination !== undefined) {
		return usageError("--remote requires --from-remote"); // DRAFT copy
	}
	return options;
}

function printUnits(machine: string, units: Awaited<ReturnType<typeof readArchivedUnits>>): void {
	if (units.length === 0) {
		process.stdout.write(`no archived sessions for ${machine}\n`);
		return;
	}
	for (const unit of units) {
		const fileCount = `${unit.files.length} file${unit.files.length === 1 ? "" : "s"}`;
		const archived = unit.archived ? " · archived" : "";
		process.stdout.write(
			`${unit.id} · ${unit.harness} · ${unit.machine} · ${fileCount} · ${new Date(unit.newestSourceMtimeMs).toISOString()}${archived}\n`,
		);
	}
}

function printRestoreResult(unit: ArchivedUnit, result: RestoreResult): void {
	for (const location of unit.supersededLocations) {
		process.stdout.write(`superseded codex location: ${location}\n`);
	}
	process.stdout.write(
		`restored ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${result.targetRoot}\n`,
	);
	for (const hint of result.resumeHints) {
		process.stdout.write(`${hint}\n`);
	}
}

export async function runRestore(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) {
		return 1;
	}
	const home = resolveHome();
	const config = loadConfig(home);
	const machine = options.machine ?? config.machine;
	if (options.fromRemote) {
		const remote = await restoreFromRemote({
			config,
			machine,
			identityPath: options.identityPath!,
			remoteDestination: options.remoteDestination,
			prefix: options.prefix,
			force: options.force,
		});
		if (remote.kind === "listed") {
			printUnits(machine, remote.units);
		} else {
			printRestoreResult(remote.unit, remote.restore);
		}
		return 0;
	}
	const units = await readArchivedUnits(config, machine);
	if (options.prefix === undefined) {
		printUnits(machine, units);
		return 0;
	}
	const unit = resolveArchivedUnit(units, options.prefix);
	const result = await restoreArchivedUnit(unit, options.force);
	printRestoreResult(unit, result);
	return 0;
}
