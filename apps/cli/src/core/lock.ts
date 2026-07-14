import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SyncLockResult<T> = { acquired: true; value: T } | { acquired: false };

interface LockContents {
	pid: number;
	startedAt: string;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM") {
			return true;
		}
		if (code === "ESRCH") {
			return false;
		}
		throw error;
	}
}

async function lockOwnerIsAlive(path: string): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) {
			return false;
		}
		return isProcessAlive((parsed as { pid: number }).pid);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
			return false;
		}
		throw error;
	}
}

async function tryAcquire(path: string): Promise<boolean> {
	const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() };
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, `${JSON.stringify(contents)}\n`, { flag: "wx" });
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return false;
			}
			throw error;
		}
	} finally {
		await rm(temporary, { force: true });
	}
	return true;
}

export async function withSyncLock<T>(statePath: string, fn: () => Promise<T>): Promise<SyncLockResult<T>> {
	await mkdir(statePath, { recursive: true });
	const path = join(statePath, "sync.lock");
	let acquired = await tryAcquire(path);
	if (!acquired) {
		if (await lockOwnerIsAlive(path)) {
			return { acquired: false };
		}
		await rm(path, { force: true });
		acquired = await tryAcquire(path);
		if (!acquired) {
			return { acquired: false };
		}
	}
	try {
		return { acquired: true, value: await fn() };
	} finally {
		await rm(path, { force: true });
	}
}
