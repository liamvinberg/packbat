/**
 * The five-axis harness adapter contract (spec #14, "Adapter contract").
 * Each supported harness is one declaration against this interface; the core
 * consumes (unit, file set, newest mtime) and knows nothing harness-specific.
 */

export type HarnessId = "claude-code" | "codex" | "pi";

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

export interface HarnessAdapter {
	id: HarnessId;
	displayName: string;
	mutationModel: MutationModel;
	/**
	 * The harness's own deletion behavior, phrased for doctor output.
	 * null = no known automatic retention.
	 */
	retentionRisk: string | null;
	/** Resolve the live store root: env override first, then the default under `home`. */
	storeRoot(env: NodeJS.ProcessEnv, home: string): string;
	/**
	 * Stat-walk the store into session units. Missing root resolves to [] —
	 * an absent harness is success, not an error. Must never read file
	 * contents (unit ids are filename-derived for all v1 harnesses).
	 */
	enumerate(storeRoot: string): Promise<SessionUnit[]>;
	/** Where an archived relPath must land for this harness's resume lookup to find it. */
	restoreTarget(storeRoot: string, relPath: string): string;
	/** Exact resume guidance printed after a successful restore, one line per string. */
	resumeHint(unit: { id: string; relPaths: string[] }): string[];
}

/**
 * A store blotter recognizes but does not yet archive. Doctor reports these as
 * "found, not yet supported" so coverage gaps are visible instead of silent.
 */
export interface UnsupportedStore {
	id: "opencode" | "gemini" | "cursor";
	displayName: string;
	/** The axis that gates support (e.g. opencode is db-snapshot). */
	mutationModel: MutationModel;
	/** The discovered store path when present on this machine, else null. */
	detect(env: NodeJS.ProcessEnv, home: string): string | null;
}
