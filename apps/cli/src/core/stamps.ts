import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RunStamp {
	startedAt: string;
	finishedAt: string;
	ok: boolean;
	archived: number;
	unchanged: number;
	failed: number;
	repaired?: number;
	offbox?: string;
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`);
	await rename(temporary, path);
}

export async function writeRunStamps(statePath: string, stamp: RunStamp): Promise<void> {
	await mkdir(statePath, { recursive: true });
	await writeAtomicJson(join(statePath, "last-run.json"), stamp);
	if (stamp.ok) {
		await writeAtomicJson(join(statePath, "last-success.json"), stamp);
	}
}
