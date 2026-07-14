import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import { readArchiveCatalog } from "../retrieval/catalog.js";
import { assertFts5 } from "../retrieval/database.js";
import { readShowUnit, resolveShowUnit, type ShowResult } from "../retrieval/show.js";

// DRAFT copy. Usage is pinned byte-for-byte by the retrieval contract.
const USAGE = "Usage: packbat show <unit-or-key> [--json]\n";

function parseOptions(argv: string[]): { value: string; json: boolean } | null {
	let value: string | null = null;
	let json = false;
	for (const argument of argv) {
		if (argument === "--json") {
			if (json) {
				// DRAFT copy
				process.stderr.write(`packbat show: --json may only be passed once\n\n${USAGE}`);
				return null;
			}
			json = true;
		} else if (argument.startsWith("-")) {
			// DRAFT copy
			process.stderr.write(`packbat show: unknown option ${argument}\n\n${USAGE}`);
			return null;
		} else if (value !== null) {
			// DRAFT copy
			process.stderr.write(`packbat show: only one unit or key may be passed\n\n${USAGE}`);
			return null;
		} else {
			value = argument;
		}
	}
	if (value === null) {
		// DRAFT copy
		process.stderr.write(`packbat show: a unit or key is required\n\n${USAGE}`);
		return null;
	}
	return { value, json };
}

function printShow(result: ShowResult): void {
	// DRAFT copy
	process.stdout.write(`${result.unit.key}\n`);
	process.stdout.write(`${result.unit.harness} · ${result.unit.machine}\n`);
	if (result.unit.projects.length > 0) process.stdout.write(`projects: ${result.unit.projects.join(", ")}\n`);
	for (const turn of result.turns) {
		process.stdout.write(`\n${turn.turn} · ${turn.role}`);
		if (turn.timestamp !== null) process.stdout.write(` · ${turn.timestamp}`);
		if (turn.project !== null) process.stdout.write(` · ${turn.project}`);
		process.stdout.write(`\n${turn.text}\n`);
		if (turn.filesTouched.length > 0) process.stdout.write(`files: ${turn.filesTouched.join(", ")}\n`);
		if (turn.commands.length > 0) process.stdout.write(`commands: ${turn.commands.join(" | ")}\n`);
	}
}

export async function runShow(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) return 1;
	assertFts5();
	const home = resolveHome();
	const config = loadConfig(home);
	// show reads raw archives, never the cache, so it takes no retrieval lock.
	const unit = resolveShowUnit(await readArchiveCatalog(config), options.value);
	const result = await readShowUnit(unit);
	if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
	else printShow(result);
	return 0;
}
