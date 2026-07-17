import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { PackbatError } from "../core/errors.js";
import { commandOnPath } from "../core/exec.js";
import { resolveHome } from "../core/home.js";
import { ensurePrivateManagedRcloneConfig } from "./managed-rclone-config.js";

export type RcloneConfigMode = "managed" | "default";
export type RcloneOAuthFailure =
	| { kind: "grant"; errorClass: "expired_access_token" | "invalid_access_token" | "invalid_grant" }
	| {
			kind: "client";
			errorClass: "invalid_client" | "invalid_scope" | "unauthorized_client" | "unsupported_grant_type";
	  };

const RCLONE_MISSING =
	"rclone was not found on PATH; install it with `brew install rclone` (macOS) or `apt install rclone` (Debian/Ubuntu)";

export async function discoverRclone(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const fromPath = commandOnPath("rclone", env);
	if (fromPath !== null) {
		return fromPath;
	}
	for (const candidate of ["/opt/homebrew/bin/rclone", "/usr/local/bin/rclone", "/usr/bin/rclone"]) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EACCES") {
				throw error;
			}
		}
	}
	throw new PackbatError(RCLONE_MISSING);
}

async function managedConfigArguments(mode: RcloneConfigMode): Promise<string[]> {
	if (mode === "default") {
		return [];
	}
	const configPath = resolveHome().rcloneConfPath;
	await ensurePrivateManagedRcloneConfig(configPath);
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
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			reject(new PackbatError(`could not start rclone: ${error.message}`));
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const output = `${stdout}${stderr}`;
			reject(new PackbatError(`rclone ${command} failed${output.trim() === "" ? "" : `: ${output.trim()}`}`));
		});
	});
}

interface RcloneListItem {
	path: string;
	isDirectory: boolean;
}

function parseRcloneList(output: string): RcloneListItem[] {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new PackbatError("rclone lsjson returned invalid JSON");
	}
	if (!Array.isArray(value)) {
		throw new PackbatError("rclone lsjson returned invalid JSON");
	}
	return value.map((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof (item as Record<string, unknown>).Path !== "string" ||
			typeof (item as Record<string, unknown>).IsDir !== "boolean"
		) {
			throw new PackbatError("rclone lsjson returned invalid JSON");
		}
		return {
			path: (item as Record<string, unknown>).Path as string,
			isDirectory: (item as Record<string, unknown>).IsDir as boolean,
		};
	});
}

export async function listRemoteDirectories(destination: string, mode: RcloneConfigMode): Promise<string[]> {
	const items = parseRcloneList(await runRclone("lsjson", [destination, "--dirs-only", "--max-depth", "1"], mode));
	return items
		.filter((item) => item.isDirectory)
		.map((item) => item.path)
		.sort((left, right) => left.localeCompare(right));
}

export async function listRemoteFiles(destination: string, mode: RcloneConfigMode): Promise<string[]> {
	const items = parseRcloneList(await runRclone("lsjson", [destination, "--files-only", "--recursive"], mode));
	return items
		.filter((item) => !item.isDirectory)
		.map((item) => item.path)
		.sort((left, right) => left.localeCompare(right));
}

export function classifyRcloneOAuthFailure(output: string): RcloneOAuthFailure | null {
	const normalized = output.toLowerCase();
	for (const errorClass of ["invalid_grant", "expired_access_token", "invalid_access_token"] as const) {
		if (normalized.includes(errorClass)) return { kind: "grant", errorClass };
	}
	for (const errorClass of [
		"invalid_client",
		"unauthorized_client",
		"unsupported_grant_type",
		"invalid_scope",
	] as const) {
		if (normalized.includes(errorClass)) return { kind: "client", errorClass };
	}
	return null;
}

export async function probeRcloneOAuth(
	destination: string,
	mode: RcloneConfigMode,
): Promise<{
	ok: boolean;
	failure: RcloneOAuthFailure | null;
}> {
	try {
		await runRclone("lsjson", [destination, "--max-depth", "1"], mode);
		return { ok: true, failure: null };
	} catch (error) {
		return { ok: false, failure: classifyRcloneOAuthFailure(error instanceof Error ? error.message : String(error)) };
	}
}

export async function remoteFileExists(destinationFile: string, mode: RcloneConfigMode): Promise<boolean> {
	let output: string;
	try {
		output = await runRclone("lsjson", [destinationFile], mode);
	} catch {
		return false;
	}
	return parseRcloneList(output).length > 0;
}

export async function copyTree(source: string, destination: string, mode: RcloneConfigMode): Promise<void> {
	await runRclone("copy", [source, destination], mode);
}

export async function copyFile(source: string, destinationFile: string, mode: RcloneConfigMode): Promise<void> {
	await runRclone("copyto", [source, destinationFile], mode);
}

export function joinRcloneDestination(destination: string, relativePath: string): string {
	const child = relativePath.replace(/^\/+/, "");
	if (destination.endsWith(":")) {
		return `${destination}${child}`;
	}
	const base = destination.replace(/\/+$/, "");
	return `${base === "" ? "/" : `${base}/`}${child}`;
}
