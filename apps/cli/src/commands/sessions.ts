// DRAFT copy. Usage is pinned byte-for-byte by the retrieval contract.
const USAGE =
	"Usage: packbat sessions [--project <path>] [--since <RFC3339>] [--harness <id>] [--machine <name>] [--file <substring>] [--command <substring>] [--limit <n>] [--json]\n";

// Stub: issue #52 (agent-funnel wave) fills this in.
export async function runSessions(_argv: string[]): Promise<number> {
	process.stderr.write(USAGE);
	return 1;
}
