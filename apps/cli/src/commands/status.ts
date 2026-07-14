import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import {
	ageMs,
	checkFresh,
	checkInstalled,
	checkLive,
	checkOffbox,
	createDoctorContext,
	formatAge,
	readHarnessTallies,
	type StampRead,
} from "../doctor/facts.js";

const USAGE = "Usage: packbat status [--json]\n";

function parseOptions(argv: string[]): { json: boolean } | null {
	if (argv.length === 0) {
		return { json: false };
	}
	if (argv.length === 1 && argv[0] === "--json") {
		return { json: true };
	}
	process.stderr.write(`packbat status: only --json is accepted\n\n${USAGE}`);
	return null;
}

function stampJson(stamp: StampRead, now: Date): unknown {
	if (stamp.kind !== "value") {
		return null;
	}
	return {
		finishedAt: stamp.value.finishedAt,
		ageMs: ageMs(stamp.finishedAtMs, now),
		ok: stamp.value.ok,
		archived: stamp.value.archived,
		unchanged: stamp.value.unchanged,
		failed: stamp.value.failed,
	};
}

function lastRunLine(stamp: StampRead, now: Date): string {
	if (stamp.kind === "missing") {
		return "never";
	}
	if (stamp.kind === "invalid") {
		return stamp.detail;
	}
	return `${formatAge(ageMs(stamp.finishedAtMs, now))} · ${stamp.value.ok ? "ok" : "failed"} · archived ${stamp.value.archived}, unchanged ${stamp.value.unchanged}, failed ${stamp.value.failed}`;
}

function lastSuccessLine(stamp: StampRead, now: Date): string {
	if (stamp.kind === "missing") {
		return "never";
	}
	if (stamp.kind === "invalid") {
		return stamp.detail;
	}
	return formatAge(ageMs(stamp.finishedAtMs, now));
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export async function runStatus(argv: string[]): Promise<number> {
	const options = parseOptions(argv);
	if (options === null) {
		return 1;
	}
	const home = resolveHome();
	const config = loadConfig(home);
	const context = createDoctorContext(config, home);
	const installed = await checkInstalled(context);
	const [live, fresh, harnesses, offbox] = await Promise.all([
		checkLive(context, installed, { probe: false }),
		checkFresh(context),
		readHarnessTallies(context),
		checkOffbox(context),
	]);
	const report = {
		v: 2,
		machine: config.machine,
		archiveRoot: config.archiveRoot,
		schedule: {
			installed: installed.fact.status === "ok",
			installedDetail: installed.fact.detail,
			live: "not-checked" as const,
			liveDetail: live.detail,
		},
		lastRun: stampJson(fresh.lastRun, context.now),
		lastSuccess: stampJson(fresh.lastSuccess, context.now),
		fresh: { status: fresh.fact.status, detail: fresh.fact.detail },
		harnesses,
		offbox: offbox.map((item) => ({ status: item.status, detail: item.detail })),
	};
	if (options.json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return 0;
	}
	process.stdout.write(`machine: ${config.machine}\n`);
	process.stdout.write(`archive: ${config.archiveRoot}\n`);
	process.stdout.write(`schedule: ${installed.fact.detail} · ${live.detail}\n`);
	process.stdout.write(`last run: ${lastRunLine(fresh.lastRun, context.now)}\n`);
	process.stdout.write(`last success: ${lastSuccessLine(fresh.lastSuccess, context.now)}\n`);
	for (const tally of harnesses) {
		process.stdout.write(
			`${tally.harness}: ${tally.units} unit${tally.units === 1 ? "" : "s"} · ${tally.files} file${tally.files === 1 ? "" : "s"} · ${formatBytes(tally.storedBytes)}\n`,
		);
	}
	for (const item of offbox) {
		process.stdout.write(`offbox: ${item.detail}\n`);
	}
	return 0;
}
