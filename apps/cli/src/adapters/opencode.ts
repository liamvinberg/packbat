import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { statOrNull } from "../core/fs.js";
import type {
	DatabaseSnapshotCapture,
	DatabaseSnapshotHarnessAdapter,
	DatabaseSnapshotUnit,
	SnapshotSession,
} from "./adapter.js";

// Keep the runtime-floor built-in intact when tsup targets a Node release it does not yet classify as a built-in.
const sqliteModule = "node:sqlite";
const { backup, DatabaseSync } = await import(sqliteModule);

function assertQuickCheck(database: Database): void {
	const results = database.prepare("PRAGMA quick_check").all();
	if (results.length !== 1 || results[0]?.quick_check !== "ok") {
		// DRAFT copy
		throw new Error("OpenCode database failed PRAGMA quick_check");
	}
}

function sessions(database: Database): SnapshotSession[] {
	return database
		.prepare("SELECT id, time_created, time_updated FROM session ORDER BY id")
		.all()
		.map((row) => {
			if (typeof row.id !== "string" || typeof row.time_created !== "number" || typeof row.time_updated !== "number") {
				// DRAFT copy
				throw new Error("OpenCode session metadata has an unsupported shape");
			}
			return { id: row.id, timeCreated: row.time_created, timeUpdated: row.time_updated };
		});
}

function softwareVersion(database: Database): string | null {
	const row = database.prepare("SELECT version FROM session ORDER BY time_updated DESC, id DESC LIMIT 1").get();
	if (row === undefined) {
		return null;
	}
	if (typeof row.version !== "string") {
		// DRAFT copy
		throw new Error("OpenCode version metadata has an unsupported shape");
	}
	return row.version;
}

async function enumerate(databasePath: string): Promise<DatabaseSnapshotUnit[]> {
	const stats = await statOrNull(databasePath);
	if (stats === null || !stats.isFile()) {
		return [];
	}
	return [{ sourcePath: databasePath, sourceMtimeMs: stats.mtimeMs, sourceSize: stats.size }];
}

async function snapshot(unit: DatabaseSnapshotUnit, destination: string): Promise<DatabaseSnapshotCapture> {
	const source = new DatabaseSync(unit.sourcePath, { readOnly: true });
	try {
		await backup(source, destination);
	} finally {
		source.close();
	}

	const completed = new DatabaseSync(destination, { readOnly: true });
	let capturedSessions: SnapshotSession[];
	let capturedVersion: string | null;
	try {
		assertQuickCheck(completed);
		capturedVersion = softwareVersion(completed);
		capturedSessions = sessions(completed);
	} finally {
		completed.close();
	}
	const bytes = await readFile(destination);
	return {
		contentSha256: createHash("sha256").update(bytes).digest("hex"),
		sizeBytes: bytes.byteLength,
		softwareVersion: capturedVersion,
		sessions: capturedSessions,
	};
}

async function validateSnapshot(snapshotPath: string, sessionId: string): Promise<void> {
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		assertQuickCheck(database);
		if (database.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId) === undefined) {
			// DRAFT copy
			throw new Error(`OpenCode snapshot does not contain session ${sessionId}`);
		}
	} finally {
		database.close();
	}
}

export const openCodeAdapter: DatabaseSnapshotHarnessAdapter = {
	id: "opencode",
	// DRAFT copy
	displayName: "OpenCode",
	mutationModel: "db-snapshot",
	// DRAFT copy
	retentionRisk:
		"OpenCode does not automatically prune session history; explicit deletion removes it from the shared SQLite database.",
	snapshotFilename: "opencode.db.zst",
	storeRoot(env, home) {
		const dataHome = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, ".local", "share");
		const dataRoot = join(dataHome, "opencode");
		if (env.OPENCODE_DB) {
			return isAbsolute(env.OPENCODE_DB) ? env.OPENCODE_DB : join(dataRoot, env.OPENCODE_DB);
		}
		// v1 intentionally auto-detects only the stable channel database.
		return join(dataRoot, "opencode.db");
	},
	enumerate,
	snapshot,
	validateSnapshot,
	resumeHint(unit) {
		// DRAFT copy
		return [`opencode -s ${unit.id}`];
	},
};
