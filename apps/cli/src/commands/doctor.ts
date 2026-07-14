import pc from "picocolors";
import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import {
	checkFresh,
	checkInstalled,
	checkLive,
	collectEnvironmentFacts,
	createDoctorContext,
	type Fact,
	remedyForFact,
	retentionFact,
} from "../doctor/facts.js";
import { checkReconciled } from "../doctor/reconcile.js";

const USAGE = "Usage: blotter doctor [--json]\n";

function parseOptions(argv: string[]): { json: boolean } | null {
	if (argv.length === 0) {
		return { json: false };
	}
	if (argv.length === 1 && argv[0] === "--json") {
		return { json: true };
	}
	process.stderr.write(`blotter doctor: only --json is accepted\n\n${USAGE}`);
	return null;
}

function symbol(item: Fact): string {
	switch (item.status) {
		case "ok":
			return pc.green("✓");
		case "problem":
			return pc.red("✗");
		case "info":
			return pc.dim("·");
	}
}

function printHuman(facts: Fact[]): void {
	for (const item of facts) {
		process.stdout.write(`${symbol(item)} ${item.title}: ${item.detail}\n`);
	}
	const problems = facts.filter((item) => item.status === "problem");
	if (problems.length > 0) {
		process.stdout.write("\nproblems:\n");
		for (const item of problems) {
			process.stdout.write(`  ${item.title}: ${remedyForFact(item)}\n`);
		}
	}
}

export async function runDoctor(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) {
		return 1;
	}
	const home = resolveHome();
	const config = loadConfig(home);
	const context = createDoctorContext(config, home);
	const installed = await checkInstalled(context);
	const [live, fresh, reconciled] = await Promise.all([
		checkLive(context, installed),
		checkFresh(context),
		checkReconciled(context),
	]);
	const environment = await collectEnvironmentFacts(context);
	const facts = [installed.fact, live, fresh.fact, reconciled, retentionFact(), ...environment];
	const ok = !facts.some((item) => item.status === "problem");
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ v: 1, ok, machine: config.machine, facts })}\n`);
	} else {
		printHuman(facts);
	}
	return ok ? 0 : 2;
}
