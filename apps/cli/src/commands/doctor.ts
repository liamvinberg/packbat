import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { loadConfig, type PackbatConfig, remoteDestination, remoteStatePath } from "../core/config.js";
import { isEnoent } from "../core/fs.js";
import { type PackbatHome, resolveHome } from "../core/home.js";
import { packbatVersion } from "../core/version.js";
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
import { fetchLatestVersion, versionFact } from "../doctor/latest-version.js";
import { checkReconciled } from "../doctor/reconcile.js";
import { createArchiveRemote } from "../offbox/remote.js";

const USAGE = "Usage: packbat doctor [--json]\n";

function parseOptions(argv: string[]): { json: boolean } | null {
	if (argv.length === 0) {
		return { json: false };
	}
	if (argv.length === 1 && argv[0] === "--json") {
		return { json: true };
	}
	process.stderr.write(`packbat doctor: only --json is accepted\n\n${USAGE}`);
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

interface MirrorStamp {
	v: 1;
	lastPulledAt: string;
	machines: number;
	pulled: number;
}

function isMirrorStamp(value: unknown): value is MirrorStamp {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).v === 1 &&
		typeof (value as Record<string, unknown>).lastPulledAt === "string" &&
		!Number.isNaN(Date.parse((value as Record<string, unknown>).lastPulledAt as string)) &&
		Number.isInteger((value as Record<string, unknown>).machines) &&
		((value as Record<string, unknown>).machines as number) >= 0 &&
		Number.isInteger((value as Record<string, unknown>).pulled) &&
		((value as Record<string, unknown>).pulled as number) >= 0
	);
}

async function mirrorFacts(home: PackbatHome, config: PackbatConfig): Promise<Fact[]> {
	if (config.offbox.mode !== "configured") {
		return [];
	}
	const facts: Fact[] = [];
	for (const remoteConfig of config.offbox.remotes) {
		const remote = createArchiveRemote(home, remoteConfig);
		if (!remote.supportsMirror) {
			continue;
		}
		const destination = remoteDestination(remoteConfig);
		let stamp: MirrorStamp | null = null;
		try {
			const value: unknown = JSON.parse(
				await readFile(join(remoteStatePath(home, remoteConfig), "mirror.json"), "utf8"),
			);
			stamp = isMirrorStamp(value) ? value : null;
		} catch (error) {
			if (!isEnoent(error) && !(error instanceof SyntaxError)) {
				throw error;
			}
		}
		facts.push(
			stamp === null
				? { id: "mirror", title: "mirror", status: "info", detail: `${destination} · not yet run` }
				: {
						id: "mirror",
						title: "mirror",
						status: "info",
						detail: `${destination} · ${stamp.machines} ${stamp.machines === 1 ? "machine" : "machines"} seen · last pulled ${stamp.lastPulledAt}`,
						data: { destination, ...stamp },
					},
		);
	}
	return facts;
}

export async function runDoctor(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) {
		return 1;
	}
	// Policy: JSON is the cron/scripting lane and never uses the network. Human output checks only at a TTY;
	// PACKBAT_REGISTRY_URL is the process-boundary test arm, avoiding ambient npm registry traffic in normal pipes.
	const shouldCheckLatestVersion =
		!options.json && (process.stdout.isTTY === true || process.env.PACKBAT_REGISTRY_URL !== undefined);
	const latestVersionPromise = shouldCheckLatestVersion ? fetchLatestVersion() : null;
	const home = resolveHome();
	const config = loadConfig(home);
	const context = createDoctorContext(config, home);
	const installed = await checkInstalled(context);
	const [live, fresh, reconciled] = await Promise.all([
		checkLive(context, installed),
		checkFresh(context),
		checkReconciled(context),
	]);
	const [environment, mirrors] = await Promise.all([collectEnvironmentFacts(context), mirrorFacts(home, config)]);
	const facts = [installed.fact, live, fresh.fact, reconciled, retentionFact(), ...environment, ...mirrors];
	if (latestVersionPromise !== null) {
		facts.push(versionFact(packbatVersion(), await latestVersionPromise));
	}
	const ok = !facts.some((item) => item.status === "problem");
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ v: 1, ok, machine: config.machine, version: packbatVersion(), facts })}\n`,
		);
	} else {
		printHuman(facts);
	}
	return ok ? 0 : 2;
}
