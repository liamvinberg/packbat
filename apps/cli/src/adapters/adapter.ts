/**
 * The five-axis harness adapter contract (spec #14, "Adapter contract").
 * Each supported harness is one declaration against this interface; the core
 * consumes either explicit session files or one store-wide database snapshot.
 */

export const HARNESS_IDS = ["claude-code", "codex", "pi", "opencode", "gemini"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function isHarnessId(value: unknown): value is HarnessId {
	return typeof value === "string" && HARNESS_IDS.some((id) => id === value);
}

export type MutationModel = "append-file" | "rewrite-file" | "db-snapshot";

export type FileRole = "main" | "sidecar";

export interface SessionFile {
	/** Absolute path of the live source file. */
	absPath: string;
	/**
	 * Path relative to the store root. This is identity: it becomes the archive
	 * path (`<machine>/<harness-id>/<relPath>.zst`) and, on restore, the exact
	 * placement under the target store root. Filenames are load-bearing for
	 * every supported harness — never rename.
	 */
	relPath: string;
	role: FileRole;
	sizeBytes: number;
	mtimeMs: number;
}

export interface SessionUnit {
	/** The harness session id — the value its resume command accepts. */
	id: string;
	/** Main file first, then session-owned sidecars. */
	files: SessionFile[];
}

export interface SnapshotSession {
	id: string;
	timeCreated: number;
	timeUpdated: number;
}

/** One point-in-time copy of a store-wide database, never a synthetic session. */
export interface DatabaseSnapshotUnit {
	sourcePath: string;
	sourceMtimeMs: number;
	sourceSize: number;
}

export interface DatabaseSnapshotCapture {
	contentSha256: string;
	sizeBytes: number;
	softwareVersion: string | null;
	sessions: SnapshotSession[];
}

interface HarnessAdapterBase {
	id: HarnessId;
	displayName: string;
	/**
	 * The harness's own deletion behavior, phrased for doctor output.
	 * null = no known automatic retention.
	 */
	retentionRisk: string | null;
	/** Resolve the live store location: env override first, then the default under `home`. */
	storeRoot(env: NodeJS.ProcessEnv, home: string): string;
}

export interface SessionHarnessAdapter extends HarnessAdapterBase {
	mutationModel: Exclude<MutationModel, "db-snapshot">;
	/**
	 * Stat-walk the store into session units. Missing root resolves to [] —
	 * an absent harness is success, not an error. Enumeration is content-blind
	 * except for Gemini CLI, which reads only bounded first-line/legacy metadata
	 * because its filenames contain only an eight-character session-id prefix.
	 */
	enumerate(storeRoot: string): Promise<SessionUnit[]>;
	/** Where an archived relPath must land for this harness's resume lookup to find it. */
	restoreTarget(storeRoot: string, relPath: string): string;
	/** Exact resume guidance printed after a successful restore, one line per string. */
	resumeHint(unit: { id: string; relPaths: string[] }): string[];
}

export interface DatabaseSnapshotHarnessAdapter extends HarnessAdapterBase {
	mutationModel: "db-snapshot";
	/** The fixed payload name inside each append-only snapshot directory. */
	snapshotFilename: string;
	/** An absent database resolves to []; a present database is one store-wide archive unit. */
	enumerate(storeRoot: string): Promise<DatabaseSnapshotUnit[]>;
	/** Create and inspect a transactionally consistent native database at `destination`. */
	snapshot(unit: DatabaseSnapshotUnit, destination: string): Promise<DatabaseSnapshotCapture>;
	/** Validate a completed native database before it becomes live. */
	validateSnapshot(snapshotPath: string, sessionId: string): Promise<void>;
	/** Exact resume guidance printed after a successful store-wide restore. */
	resumeHint(unit: { id: string; targetPath: string }): string[];
}

export type HarnessAdapter = SessionHarnessAdapter | DatabaseSnapshotHarnessAdapter;

/**
 * A store blotter recognizes but does not yet archive. Doctor reports these as
 * "found, not yet supported" so coverage gaps are visible instead of silent.
 */
export interface UnsupportedStore {
	id: "cursor";
	displayName: string;
	/** The axis that gates support; Cursor does not disclose its persistence. */
	mutationModel: MutationModel | "undisclosed";
	/** The discovered store path when present on this machine, else null. */
	detect(env: NodeJS.ProcessEnv, home: string): string | null;
}
