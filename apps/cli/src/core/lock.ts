import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SyncLockResult<T> = { acquired: true; value: T } | { acquired: false };

const RETRIEVAL_LOCK_POLL_INTERVAL_MS = 250;
const RETRIEVAL_LOCK_WAIT_TIMEOUT_MS = 15_000;

export interface LockContents {
	pid: number;
	startedAt: string;
}

export async function readLockHolder(statePath: string, name: string): Promise<LockContents | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(statePath, `${name}.lock`), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("pid" in parsed) || !("startedAt" in parsed)) {
			return null;
		}
		const { pid, startedAt } = parsed as { pid: unknown; startedAt: unknown };
		return typeof pid === "number" && typeof startedAt === "string" ? { pid, startedAt } : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
			return null;
		}
		throw error;
	}
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

async function wait(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withLock<T>(
	statePath: string,
	name: string,
	fn: () => Promise<T>,
	waitForLiveOwner: boolean,
): Promise<SyncLockResult<T>> {
	await mkdir(statePath, { recursive: true });
	const path = join(statePath, `${name}.lock`);
	let acquired = await tryAcquire(path);
	if (!acquired) {
		if (await lockOwnerIsAlive(path)) {
			if (!waitForLiveOwner) return { acquired: false };
			const deadline = Date.now() + RETRIEVAL_LOCK_WAIT_TIMEOUT_MS;
			while (!acquired) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				await wait(Math.min(RETRIEVAL_LOCK_POLL_INTERVAL_MS, remaining));
				acquired = await tryAcquire(path);
				if (!acquired && !(await lockOwnerIsAlive(path))) {
					await rm(path, { force: true });
					acquired = await tryAcquire(path);
				}
			}
			if (!acquired) return { acquired: false };
		} else {
			await rm(path, { force: true });
			acquired = await tryAcquire(path);
			if (!acquired) {
				return { acquired: false };
			}
		}
	}
	try {
		return { acquired: true, value: await fn() };
	} finally {
		await rm(path, { force: true });
	}
}

export async function withSyncLock<T>(statePath: string, fn: () => Promise<T>): Promise<SyncLockResult<T>> {
	return await withLock(statePath, "sync", fn, false);
}

export async function withRetrievalLock<T>(statePath: string, fn: () => Promise<T>): Promise<SyncLockResult<T>> {
	return await withLock(statePath, "retrieval", fn, true);
}

/** Like withRetrievalLock but returns immediately when a live owner holds the lock. */
export async function tryRetrievalLock<T>(statePath: string, fn: () => Promise<T>): Promise<SyncLockResult<T>> {
	return await withLock(statePath, "retrieval", fn, false);
}

/** Local wall-clock start time of the lock holder, or null when there is no readable holder. */
export async function lockHolderStartTime(statePath: string, name: string): Promise<string | null> {
	const holder = await readLockHolder(statePath, name);
	const started = holder === null ? Number.NaN : new Date(holder.startedAt).getTime();
	if (Number.isNaN(started)) return null;
	return new Date(started).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
