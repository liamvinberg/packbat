import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as zlib from "node:zlib";
import { PackbatError } from "./errors.js";

export interface CompressionResult {
	sourceMtimeMs: number;
	sourceSize: number;
	storedSize: number;
	sha256: string;
}

export function assertZstdSupport(): void {
	if (typeof zlib.zstdCompressSync !== "function" || typeof zlib.zstdDecompressSync !== "function") {
		// DRAFT copy
		throw new PackbatError("zstd compression requires Node >= 22.16");
	}
}

export async function compressFile(source: string, destination: string): Promise<CompressionResult> {
	assertZstdSupport();
	const sourceStat = await stat(source);
	const sourceBytes = await readFile(source);
	const storedBytes = zlib.zstdCompressSync(sourceBytes);
	const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(temporary, storedBytes);
		await rename(temporary, destination);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
	await utimes(destination, sourceStat.atimeMs / 1000, sourceStat.mtimeMs / 1000);
	return {
		sourceMtimeMs: sourceStat.mtimeMs,
		sourceSize: sourceStat.size,
		storedSize: storedBytes.byteLength,
		sha256: createHash("sha256").update(storedBytes).digest("hex"),
	};
}

export async function decompressFile(source: string): Promise<Buffer> {
	return decompressBytes(await readFile(source));
}

export function decompressBytes(bytes: Buffer): Buffer {
	assertZstdSupport();
	return zlib.zstdDecompressSync(bytes);
}
