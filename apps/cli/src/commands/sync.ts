import { cloudUpdateAvailableVersion } from "../cloud/api-fetch.js";
import { sweep } from "../core/archive.js";
import { assertZstdSupport } from "../core/compress.js";
import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import { withSyncLock } from "../core/lock.js";
import { appendLog } from "../core/log.js";
import { writeRunStamps } from "../core/stamps.js";
import { publishOffbox, type RemotePublishOutcome, remindOffboxSkipped } from "../offbox/outbox.js";

const USAGE = "Usage: packbat sync\n";

export interface SyncOutputOptions {
	writeSummary?: boolean;
	onSummary?: (summary: string) => void;
	onBusy?: () => void;
}

function reportSummary(summary: string, options: SyncOutputOptions): void {
	options.onSummary?.(summary);
	if (options.writeSummary !== false) {
		process.stdout.write(`${summary}\n`);
	}
}

function reportCloudUpdate(): void {
	const version = cloudUpdateAvailableVersion();
	if (version !== null) {
		process.stdout.write(`packbat ${version} is available, update with npm install --global packbat@latest\n`); // DRAFT copy
	}
}

function offboxSummary(outcomes: RemotePublishOutcome[]): string {
	return `off-box ${outcomes.filter((outcome) => outcome.ok).length}/${outcomes.length}`; // DRAFT copy
}

export async function runSync(argv: string[], output: SyncOutputOptions = {}): Promise<number> {
	if (argv.length > 0) {
		process.stderr.write(USAGE);
		return 1;
	}
	const home = resolveHome();
	const config = loadConfig(home);
	assertZstdSupport();
	const locked = await withSyncLock(home.statePath, async () => {
		const startedAt = new Date().toISOString();
		let archived = 0;
		let unchanged = 0;
		let failed = 0;
		let repaired = 0;
		let errors: string[] = [];
		let offboxOutcomes: RemotePublishOutcome[] = [];
		let offboxError: string | undefined;
		try {
			const result = await sweep(config, process.env);
			archived = result.archived;
			unchanged = result.unchanged;
			failed = result.failed;
			repaired = result.repaired;
			errors = result.errors;
		} catch (error) {
			failed = 1;
			errors = [`sweep: ${error instanceof Error ? error.message : String(error)}`];
		}
		const ok = failed === 0;
		if (ok) {
			try {
				if (config.offbox.mode === "configured") {
					offboxOutcomes = await publishOffbox(home, config, config.offbox);
				} else {
					await remindOffboxSkipped(home);
				}
			} catch (error) {
				offboxError = error instanceof Error ? error.message : String(error);
			}
		}
		const offboxFailures = offboxOutcomes.filter(
			(outcome): outcome is RemotePublishOutcome & { error: string } => !outcome.ok && outcome.error !== undefined,
		);
		const finishedAt = new Date().toISOString();
		const summary = `archived ${archived}, unchanged ${unchanged}, failed ${failed}${repaired > 0 ? `, repaired ${repaired}` : ""}${offboxOutcomes.length > 0 ? `, ${offboxSummary(offboxOutcomes)}` : ""}`; // DRAFT copy
		await writeRunStamps(home.statePath, {
			startedAt,
			finishedAt,
			ok,
			archived,
			unchanged,
			failed,
			repaired,
			...(offboxFailures.length > 0
				? { offbox: offboxFailures.map((outcome) => `${outcome.destination}: ${outcome.error}`).join("; ") }
				: offboxError === undefined
					? {}
					: { offbox: offboxError }),
		});
		await appendLog(home.logsPath, summary, new Date(finishedAt));
		if (offboxError !== undefined) {
			await appendLog(home.logsPath, `off-box failed: ${offboxError}`, new Date(finishedAt));
		}
		for (const outcome of offboxFailures) {
			await appendLog(home.logsPath, `off-box failed (${outcome.destination}): ${outcome.error}`, new Date(finishedAt)); // DRAFT copy
		}
		for (const error of errors) {
			process.stderr.write(`packbat sync: ${error}\n`);
		}
		if (offboxError !== undefined) {
			process.stderr.write(`packbat sync: off-box: ${offboxError}\n`);
		}
		for (const outcome of offboxFailures) {
			process.stderr.write(`packbat sync: off-box ${outcome.destination}: ${outcome.error}\n`); // DRAFT copy
		}
		reportSummary(summary, output);
		reportCloudUpdate();
		return ok && offboxFailures.length === 0 && offboxError === undefined ? 0 : 1;
	});
	if (!locked.acquired) {
		output.onBusy?.();
		reportSummary("sync already running", output);
		return 0;
	}
	return locked.value;
}
