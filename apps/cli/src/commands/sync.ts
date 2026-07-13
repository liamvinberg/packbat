import { sweep } from "../core/archive.js";
import { assertZstdSupport } from "../core/compress.js";
import { loadConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import { withSyncLock } from "../core/lock.js";
import { appendLog } from "../core/log.js";
import { writeRunStamps } from "../core/stamps.js";
import { publishOffbox, remindOffboxSkipped } from "../offbox/outbox.js";

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

export async function runSync(_argv: string[], output: SyncOutputOptions = {}): Promise<number> {
	const home = resolveHome();
	const config = loadConfig(home);
	assertZstdSupport();
	const locked = await withSyncLock(home.statePath, async () => {
		const startedAt = new Date().toISOString();
		let archived = 0;
		let unchanged = 0;
		let failed = 0;
		let errors: string[] = [];
		let offboxError: string | undefined;
		try {
			const result = await sweep(config, process.env);
			archived = result.archived;
			unchanged = result.unchanged;
			failed = result.failed;
			errors = result.errors;
		} catch (error) {
			failed = 1;
			errors = [`sweep: ${error instanceof Error ? error.message : String(error)}`];
		}
		const ok = failed === 0;
		if (ok) {
			try {
				if (config.offbox.mode === "configured") {
					await publishOffbox(home, config, config.offbox);
				} else {
					await remindOffboxSkipped(home);
				}
			} catch (error) {
				offboxError = error instanceof Error ? error.message : String(error);
			}
		}
		const finishedAt = new Date().toISOString();
		const summary = `archived ${archived}, unchanged ${unchanged}, failed ${failed}`;
		await writeRunStamps(home.statePath, {
			startedAt,
			finishedAt,
			ok,
			archived,
			unchanged,
			failed,
			...(offboxError === undefined ? {} : { offbox: offboxError }),
		});
		await appendLog(home.logsPath, summary, new Date(finishedAt));
		if (offboxError !== undefined) {
			await appendLog(home.logsPath, `off-box failed: ${offboxError}`, new Date(finishedAt));
		}
		for (const error of errors) {
			process.stderr.write(`blotter sync: ${error}\n`);
		}
		if (offboxError !== undefined) {
			process.stderr.write(`blotter sync: off-box: ${offboxError}\n`);
		}
		reportSummary(summary, output);
		return ok && offboxError === undefined ? 0 : 1;
	});
	if (!locked.acquired) {
		output.onBusy?.();
		reportSummary("sync already running", output);
		return 0;
	}
	return locked.value;
}
