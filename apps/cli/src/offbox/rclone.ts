import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, open } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { BlotterError } from "../core/errors.js";
import { resolveHome } from "../core/home.js";

export type RcloneConfigMode = "managed" | "default";

const RCLONE_MISSING =
	"rclone was not found on PATH; install it with `brew install rclone` (macOS) or `apt install rclone` (Debian/Ubuntu)";

export async function discoverRclone(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (directory === "") {
			continue;
		}
		const candidate = join(directory, "rclone");
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EACCES") {
				throw error;
			}
		}
	}
	throw new BlotterError(RCLONE_MISSING);
}

async function managedConfigArguments(mode: RcloneConfigMode): Promise<string[]> {
	if (mode === "default") {
		return [];
	}
	const configPath = resolveHome().rcloneConfPath;
	await mkdir(dirname(configPath), { recursive: true });
	const handle = await open(configPath, "a", 0o600);
	await handle.close();
	await chmod(configPath, 0o600);
	return ["--config", configPath];
}

async function runRclone(
	command: "copy" | "copyto" | "lsjson",
	args: string[],
	mode: RcloneConfigMode,
): Promise<string> {
	const executable = await discoverRclone();
	const configArguments = await managedConfigArguments(mode);
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(executable, [command, ...configArguments, ...args], {
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			reject(new BlotterError(`could not start rclone: ${error.message}`));
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve(output);
				return;
			}
			reject(new BlotterError(`rclone ${command} failed${output.trim() === "" ? "" : `: ${output.trim()}`}`));
		});
	});
}

export async function copyTree(source: string, destination: string, mode: RcloneConfigMode): Promise<void> {
	await runRclone("copy", [source, destination], mode);
}

export async function copyFile(source: string, destinationFile: string, mode: RcloneConfigMode): Promise<void> {
	await runRclone("copyto", [source, destinationFile], mode);
}

export async function statRemoteFile(path: string, mode: RcloneConfigMode): Promise<void> {
	const output = await runRclone("lsjson", ["--stat", path], mode);
	let item: unknown;
	try {
		item = JSON.parse(output);
	} catch {
		throw new BlotterError("rclone lsjson returned invalid JSON");
	}
	if (
		typeof item !== "object" ||
		item === null ||
		Array.isArray(item) ||
		(item as { IsDir?: unknown }).IsDir !== false
	) {
		throw new BlotterError(`rclone lsjson did not find a file at ${path}`);
	}
}

export function joinRcloneDestination(destination: string, relativePath: string): string {
	const child = relativePath.replace(/^\/+/, "");
	if (destination.endsWith(":")) {
		return `${destination}${child}`;
	}
	const base = destination.replace(/\/+$/, "");
	return `${base === "" ? "/" : `${base}/`}${child}`;
}
