import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writePrivateFile(
	path: string,
	contents: string,
	options: { overwrite: boolean } = { overwrite: true },
): Promise<void> {
	const directory = dirname(path);
	const temporary = join(directory, `.blotter-private.tmp-${process.pid}-${randomUUID()}`);
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(temporary, contents, { mode: 0o600 });
		await chmod(temporary, 0o600);
		if (options.overwrite) {
			await rename(temporary, path);
		} else {
			await link(temporary, path);
			await rm(temporary);
		}
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
