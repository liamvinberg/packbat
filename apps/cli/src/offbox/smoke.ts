import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackbatConfig, RemoteConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { resolveHome } from "../core/home.js";
import { decryptWithIdentity } from "./age.js";
import { createArchiveRemote } from "./remote.js";

export async function smokeTestRemoteIndex(
	config: PackbatConfig,
	remoteConfig: RemoteConfig,
	identity: string,
): Promise<void> {
	const remote = createArchiveRemote(resolveHome(), remoteConfig);
	if (!(await remote.indexExists(config.machine))) {
		// DRAFT copy
		throw new PackbatError("remote index does not exist");
	}

	const stagePath = await mkdtemp(join(tmpdir(), "packbat-offbox-smoke-"));
	try {
		const encryptedIndexPath = join(stagePath, "index.jsonl.age");
		await remote.getIndex(config.machine, encryptedIndexPath);
		const [localIndex, ciphertext] = await Promise.all([
			readFile(join(config.archiveRoot, config.machine, "index.jsonl")),
			readFile(encryptedIndexPath),
		]);
		const remoteIndexContents = await decryptWithIdentity(identity, ciphertext);
		if (!remoteIndexContents.equals(localIndex)) {
			throw new PackbatError("downloaded remote index does not match the local index");
		}
	} finally {
		await rm(stagePath, { recursive: true, force: true });
	}
}
