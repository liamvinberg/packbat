import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything Packbat owns lives under one directory so wholesale backup of
 * Packbat itself is trivial. `PACKBAT_HOME` overrides (also the test seam).
 */
export interface PackbatHome {
	root: string;
	configPath: string;
	statePath: string;
	logsPath: string;
	cachePath: string;
	/** Default archive root; config.archiveRoot may point elsewhere. */
	defaultArchiveRoot: string;
	/** Packbat-owned rclone config (offbox "managed" mode). */
	rcloneConfPath: string;
	/** Rotating Packbat Cloud credential. Always mode 0600. */
	cloudCredentialsPath: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): PackbatHome {
	const override = env.PACKBAT_HOME?.trim();
	const root = override ? override : join(homedir(), ".packbat");
	return {
		root,
		configPath: join(root, "config.json"),
		statePath: join(root, "state"),
		logsPath: join(root, "logs"),
		cachePath: join(root, "cache"),
		defaultArchiveRoot: join(root, "archive"),
		rcloneConfPath: join(root, "rclone.conf"),
		cloudCredentialsPath: join(root, "cloud-credentials.json"),
	};
}
