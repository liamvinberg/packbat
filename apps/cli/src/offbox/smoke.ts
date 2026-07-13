import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlotterConfig, OffboxConfig } from "../core/config.js";
import { BlotterError } from "../core/errors.js";
import { decryptWithIdentity } from "./age.js";
import { copyFile, joinRcloneDestination, statRemoteFile } from "./rclone.js";

type ConfiguredOffbox = Extract<OffboxConfig, { mode: "configured" }>;

export async function smokeTestRemoteIndex(
	config: BlotterConfig,
	offbox: ConfiguredOffbox,
	identity: string,
): Promise<void> {
	const remoteIndex = joinRcloneDestination(offbox.remote.destination, `${config.machine}/index.jsonl.age`);
	await statRemoteFile(remoteIndex, offbox.remote.rcloneConfig);

	const stagePath = await mkdtemp(join(tmpdir(), "blotter-offbox-smoke-"));
	try {
		const encryptedIndexPath = join(stagePath, "index.jsonl.age");
		await copyFile(remoteIndex, encryptedIndexPath, offbox.remote.rcloneConfig);
		const [localIndex, ciphertext] = await Promise.all([
			readFile(join(config.archiveRoot, config.machine, "index.jsonl")),
			readFile(encryptedIndexPath),
		]);
		const remoteIndexContents = await decryptWithIdentity(identity, ciphertext);
		if (!remoteIndexContents.equals(localIndex)) {
			throw new BlotterError("downloaded remote index does not match the local index");
		}
	} finally {
		await rm(stagePath, { recursive: true, force: true });
	}
}
