import type { Dirent, Stats } from "node:fs";
import { lstatSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";

export function isEnoent(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function statOrNull(path: string): Promise<Stats | null> {
	try {
		return await stat(path);
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
}

export async function readDirectoryOrEmpty(path: string): Promise<Dirent[]> {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		throw error;
	}
}

export function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isEnoent(error)) {
			return false;
		}
		throw error;
	}
}
