import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

export interface InteractiveStep {
	waitFor: string;
	reply: string | (() => string | Promise<string>);
}

export function enter(value = ""): string {
	return `${value}\r`;
}

export function moveUp(count: number): string {
	return `${"\u001b[A".repeat(count)}\r`;
}

export function moveDown(count: number): string {
	return `${"\u001b[B".repeat(count)}\r`;
}

export function backspaces(count: number): string {
	return "\u007f".repeat(count);
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

export async function runInteractiveCli(
	args: string[],
	options: RunCliOptions,
	steps: readonly InteractiveStep[],
): Promise<CliResult> {
	const command = [process.execPath, cliEntry, ...args];
	const ptyBridge = `
import fcntl, os, pty, select, struct, sys, termios
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
inputs = [0, master]
while master in inputs:
    readable, _, _ = select.select(inputs, [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if data:
            os.write(master, data)
        else:
            inputs.remove(0)
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            inputs.remove(master)
            break
        if data:
            os.write(1, data)
        else:
            inputs.remove(master)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
	return await new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", ptyBridge, ...command], {
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
		let stepIndex = 0;
		let responding = false;
		const timeout = setTimeout(() => {
			reject(new Error(`interactive CLI timed out after step ${stepIndex}:\n${stdout}${stderr}`));
			child.kill();
		}, 15_000);
		const advance = async (): Promise<void> => {
			if (responding) return;
			const step = steps[stepIndex];
			if (step === undefined || !`${stdout}${stderr}`.includes(step.waitFor)) return;
			responding = true;
			try {
				const reply = typeof step.reply === "function" ? await step.reply() : step.reply;
				child.stdin.write(reply);
				stepIndex += 1;
				responding = false;
				await advance();
			} catch (error) {
				reject(error);
				child.kill();
			}
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			void advance();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			void advance();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (stepIndex !== steps.length) {
				reject(new Error(`interactive CLI stopped before step ${stepIndex + 1}:\n${stdout}${stderr}`));
				return;
			}
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

/** A throwaway $HOME under the OS temp dir. */
export async function makeTempHome(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "packbat-test-"));
}

export async function acquireOAuthCallbackPort(): Promise<() => Promise<void>> {
	const lockPath = join(tmpdir(), `packbat-oauth-callback-${process.ppid}.lock`);
	// 60s of attempts: slow two-core CI runners serialize several full OAuth flows
	// behind this lock, so the wait must outlast a competing flow, not a fast one.
	for (let attempt = 0; attempt < 2_400; attempt += 1) {
		try {
			await mkdir(lockPath);
			return async () => await rm(lockPath, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error("timed out waiting for the OAuth callback port");
}
