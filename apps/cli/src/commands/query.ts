// DRAFT copy. Usage is pinned byte-for-byte by the retrieval contract.
const USAGE = "Usage: packbat query <select-sql> [--json]\n";

// Stub: issue #53 (agent-funnel wave) fills this in.
export async function runQuery(_argv: string[]): Promise<number> {
	process.stderr.write(USAGE);
	return 1;
}
