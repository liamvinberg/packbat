import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything blotter owns lives under one directory so wholesale backup of
 * blotter itself is trivial. `BLOTTER_HOME` overrides (also the test seam).
 */
export interface BlotterHome {
	root: string;
	configPath: string;
	statePath: string;
	logsPath: string;
	/** Default archive root; config.archiveRoot may point elsewhere. */
	defaultArchiveRoot: string;
	/** Blotter-owned rclone config (offbox "managed" mode). */
	rcloneConfPath: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): BlotterHome {
	const override = env.BLOTTER_HOME?.trim();
	const root = override ? override : join(homedir(), ".blotter");
	return {
		root,
		configPath: join(root, "config.json"),
		statePath: join(root, "state"),
		logsPath: join(root, "logs"),
		defaultArchiveRoot: join(root, "archive"),
		rcloneConfPath: join(root, "rclone.conf"),
	};
}
