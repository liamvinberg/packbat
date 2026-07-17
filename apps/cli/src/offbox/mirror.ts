import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type OffboxConfig, type PackbatConfig, remoteDestination, remoteStatePath } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { isEnoent } from "../core/fs.js";
import type { PackbatHome } from "../core/home.js";
import { readIndex } from "../core/index.js";
import { appendLog } from "../core/log.js";
import { writeAtomicJson } from "../core/stamps.js";
import { decryptWithIdentity, parseIdentityFile } from "./age.js";
import { type ArchiveRemote, createArchiveRemote } from "./remote.js";

type ConfiguredOffbox = Extract<OffboxConfig, { mode: "configured" }>;

export type RemoteMirrorOutcome =
	| { destination: string; ok: true; lastPulledAt: string; machines: number; pulled: number }
	| { destination: string; ok: false; error: string; lastPulledAt?: string; machines?: number; pulled: number };

export interface MirrorResult {
	outcomes: RemoteMirrorOutcome[];
	pulled: number;
}

interface MachineMirrorResult {
	pulled: number;
	errors: string[];
}

function temporaryPath(destination: string, label: string): string {
	return join(dirname(destination), `.${basename(destination)}.${label}-${process.pid}-${randomUUID()}`);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const value = await stat(path);
		if (!value.isFile()) {
			throw new PackbatError(`${path} exists but is not a file`);
		}
		return true;
	} catch (error) {
		if (isEnoent(error)) {
			return false;
		}
		throw error;
	}
}

function safeRelativeParts(path: string): string[] | null {
	if (path === "" || path.startsWith("/") || path.includes("\\")) {
		return null;
	}
	const parts = path.split("/");
	return parts.some((part) => part === "" || part === "." || part === "..") ? null : parts;
}

function machineNameIsSafe(machine: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/u.test(machine);
}

async function pullObject(options: {
	remote: ArchiveRemote;
	identity: string;
	localMachine: string;
	remoteMachine: string;
	objectPath: string;
	destination: string;
	sha256: string | undefined;
	mtimeMs: number | undefined;
}): Promise<boolean> {
	if (await fileExists(options.destination)) {
		return false;
	}
	await mkdir(dirname(options.destination), { recursive: true });
	const ciphertextPath = temporaryPath(options.destination, "ciphertext");
	const plaintextPath = temporaryPath(options.destination, "plaintext");
	try {
		await options.remote.getArchiveObject(options.remoteMachine, options.objectPath, ciphertextPath);
		const plaintext = await decryptWithIdentity(options.identity, await readFile(ciphertextPath));
		if (options.sha256 !== undefined) {
			const actual = createHash("sha256").update(plaintext).digest("hex");
			if (actual !== options.sha256) {
				throw new PackbatError(`sha256 mismatch for ${options.localMachine}/${options.objectPath}`);
			}
		}
		await writeFile(plaintextPath, plaintext);
		if (options.mtimeMs !== undefined) {
			const mtime = new Date(options.mtimeMs);
			await utimes(plaintextPath, mtime, mtime);
		}
		await rename(plaintextPath, options.destination);
		return true;
	} finally {
		await Promise.all([rm(ciphertextPath, { force: true }), rm(plaintextPath, { force: true })]);
	}
}

async function mirrorMachine(options: {
	remote: ArchiveRemote;
	identity: string;
	archiveRoot: string;
	currentMachine: string;
	handle: string;
	handleIsName: boolean;
}): Promise<MachineMirrorResult | null> {
	await mkdir(options.archiveRoot, { recursive: true });
	const temporaryIndexPath = join(options.archiveRoot, "index.jsonl");
	const encryptedIndexPath = temporaryPath(temporaryIndexPath, "ciphertext");
	const decryptedIndexPath = temporaryPath(temporaryIndexPath, "plaintext");
	try {
		await options.remote.getIndex(options.handle, encryptedIndexPath);
		const indexBytes = await decryptWithIdentity(options.identity, await readFile(encryptedIndexPath));
		await writeFile(decryptedIndexPath, indexBytes);
		const index = await readIndex(decryptedIndexPath);
		const indexedMachines = new Set([...index.records.values()].map((record) => record.machine));
		const localMachine = options.handleIsName
			? options.handle
			: indexedMachines.size === 1
				? indexedMachines.values().next().value
				: undefined;
		if (localMachine === undefined || localMachine === options.currentMachine || !machineNameIsSafe(localMachine)) {
			return null;
		}

		const machineRoot = join(options.archiveRoot, localMachine);
		const indexPath = join(machineRoot, "index.jsonl");
		await mkdir(machineRoot, { recursive: true });
		const objects = await options.remote.listMachineObjects(options.handle);
		if (objects === null) {
			throw new PackbatError("remote does not support archive object listing");
		}

		let pulled = 0;
		const errors: string[] = [];
		for (const objectPath of objects) {
			const parts = safeRelativeParts(objectPath);
			if (parts === null) {
				errors.push(`${localMachine}/${objectPath}: unsafe remote object path`);
				continue;
			}
			const record = index.records.get(objectPath);
			try {
				if (
					await pullObject({
						remote: options.remote,
						identity: options.identity,
						localMachine,
						remoteMachine: options.handle,
						objectPath,
						destination: join(machineRoot, ...parts),
						sha256: record?.sha256,
						mtimeMs: record?.sourceMtimeMs,
					})
				) {
					pulled += 1;
				}
			} catch (error) {
				errors.push(`${localMachine}/${objectPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		for (const record of index.records.values()) {
			const parts = safeRelativeParts(record.path);
			if (parts === null) {
				errors.push(`${localMachine}/${record.path}: unsafe index path`);
				continue;
			}
			try {
				if (!(await fileExists(join(machineRoot, ...parts)))) {
					errors.push(`${localMachine}/${record.path}: indexed object is missing`);
				}
			} catch (error) {
				errors.push(`${localMachine}/${record.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (await fileExists(indexPath)) {
			const localIndex = await readIndex(indexPath);
			if ([...localIndex.records.keys()].some((path) => !index.records.has(path))) {
				errors.push(`${localMachine}: remote index regressed`);
			}
		}

		if (errors.length === 0) {
			await rename(decryptedIndexPath, indexPath);
		}
		return { pulled, errors };
	} finally {
		await Promise.all([rm(encryptedIndexPath, { force: true }), rm(decryptedIndexPath, { force: true })]);
	}
}

async function mirrorRemote(
	home: PackbatHome,
	config: PackbatConfig,
	identity: string,
	remote: ArchiveRemote,
): Promise<RemoteMirrorOutcome | null> {
	const listedMachines = await remote.listMachines();
	if (listedMachines === null) {
		return null;
	}
	const machines = [...new Set(listedMachines)].filter((machine) => machine !== config.machine);
	let pulled = 0;
	const errors: string[] = [];
	for (const handle of machines) {
		if (!machineNameIsSafe(handle) && remote.config.type !== "cloud") {
			errors.push(`${handle}: unsafe remote machine name`);
			continue;
		}
		try {
			const result = await mirrorMachine({
				remote,
				identity,
				archiveRoot: config.archiveRoot,
				currentMachine: config.machine,
				handle,
				handleIsName: remote.config.type !== "cloud",
			});
			if (result === null) {
				continue;
			}
			pulled += result.pulled;
			errors.push(...result.errors);
		} catch (error) {
			errors.push(`${handle}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const lastPulledAt = new Date().toISOString();
	await writeAtomicJson(join(remoteStatePath(home, remote.config), "mirror.json"), {
		v: 1,
		lastPulledAt,
		machines: machines.length,
		pulled,
	});
	return errors.length === 0
		? { destination: remote.destination, ok: true, lastPulledAt, machines: machines.length, pulled }
		: {
				destination: remote.destination,
				ok: false,
				error: `mirror: ${errors.join("; ")}`,
				lastPulledAt,
				machines: machines.length,
				pulled,
			};
}

export async function mirrorOffbox(
	home: PackbatHome,
	config: PackbatConfig,
	offbox: ConfiguredOffbox,
): Promise<MirrorResult> {
	let identityContents: string;
	try {
		identityContents = await readFile(home.identityPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			await appendLog(home.logsPath, "mirror skipped: resident identity is missing"); // DRAFT copy
			return { outcomes: [], pulled: 0 };
		}
		throw error;
	}
	const identity = parseIdentityFile(identityContents);
	const outcomes: RemoteMirrorOutcome[] = [];
	for (const remoteConfig of offbox.remotes) {
		const remote = createArchiveRemote(home, remoteConfig);
		try {
			const outcome = await mirrorRemote(home, config, identity, remote);
			if (outcome !== null) {
				outcomes.push(outcome);
			}
		} catch (error) {
			outcomes.push({
				destination: remoteDestination(remoteConfig),
				ok: false,
				error: `mirror: ${error instanceof Error ? error.message : String(error)}`,
				pulled: 0,
			});
		}
	}
	return { outcomes, pulled: outcomes.reduce((sum, outcome) => sum + outcome.pulled, 0) };
}
