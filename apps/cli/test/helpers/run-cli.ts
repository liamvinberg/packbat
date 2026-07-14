import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The primary test seam (spec #14, "Testing Decisions"): invoke the built CLI
 * as a subprocess with environment-pointed temporary roots, assert only what a
 * user or script could observe — exit codes, output, files on disk.
 */

const cliEntry = fileURLToPath(new URL("../../bin/packbat.js", import.meta.url));

export interface RunCliOptions {
	/**
	 * Fake $HOME for the process. Every default root (packbat home, harness
	 * stores, LaunchAgents) resolves under it, so tests are hermetic: the
	 * developer's real stores and scheduler are unreachable by construction.
	 */
	home: string;
	/** Extra env (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_SESSION_DIR overrides). */
	env?: Record<string, string>;
	cwd?: string;
	stdin?: string;
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function runCli(args: string[], options: RunCliOptions): Promise<CliResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliEntry, ...args], {
			cwd: options.cwd ?? options.home,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: options.home,
				TMPDIR: process.env.TMPDIR ?? "",
				...options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

/** A throwaway $HOME under the OS temp dir. */
export async function makeTempHome(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "packbat-test-"));
}
