// DRAFT copy. Usage is pinned byte-for-byte by the retrieval contract.
const USAGE = "Usage: packbat outline <unit-or-key> [--turns <a:b>] [--json]\n";

// Stub: issue #51 (agent-funnel wave) fills this in.
export async function runOutline(_argv: string[]): Promise<number> {
	process.stderr.write(USAGE);
	return 1;
}
