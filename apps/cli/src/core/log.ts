import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;
const LOG_NAME = "packbat.log";

async function renameIfPresent(source: string, destination: string): Promise<void> {
	try {
		await rename(source, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

async function rotate(path: string): Promise<void> {
	await rm(`${path}.3`, { force: true });
	await renameIfPresent(`${path}.2`, `${path}.3`);
	await renameIfPresent(`${path}.1`, `${path}.2`);
	await renameIfPresent(path, `${path}.1`);
}

export async function appendLog(logsPath: string, line: string, at: Date = new Date()): Promise<void> {
	await mkdir(logsPath, { recursive: true });
	const path = join(logsPath, LOG_NAME);
	const entry = `[${at.toISOString()}] ${line}\n`;
	let existingSize = 0;
	try {
		existingSize = (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	if (existingSize + Buffer.byteLength(entry) > MAX_LOG_BYTES) {
		await rotate(path);
	}
	await appendFile(path, entry);
}
