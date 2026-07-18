import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
	cloudDownloadUrl,
	downloadCloudObject,
	listCloudMachineObjects,
	listCloudMachines,
	uploadCloudObject,
} from "../cloud/client.js";
import { type RemoteConfig, remoteDestination, remoteStatePath } from "../core/config.js";
import { isEnoent } from "../core/fs.js";
import type { PackbatHome } from "../core/home.js";
import { writeAtomicJson } from "../core/stamps.js";
import {
	copyFile,
	copyTree,
	joinRcloneDestination,
	listRemoteDirectories,
	listRemoteFiles,
	remoteFileExists,
} from "./rclone.js";

export interface ArchiveRemote {
	readonly config: RemoteConfig;
	readonly destination: string;
	readonly supportsMirror: boolean;
	readonly mirrorHandleIsName: boolean;
	indexExists(machine: string): Promise<boolean>;
	/** onObject fires per uploaded object with its machine-relative key; remotes without per-object events never call it. */
	putArchiveObjects(machine: string, sourceRoot: string, onObject?: (key: string) => void): Promise<void>;
	putIndex(machine: string, sourcePath: string): Promise<void>;
	getIndex(machine: string, destinationPath: string): Promise<void>;
	getArchiveObject(machine: string, archivePath: string, destinationPath: string): Promise<void>;
	listMachines(): Promise<string[] | null>;
	listMachineObjects(machine: string): Promise<string[] | null>;
}

class RcloneArchiveRemote implements ArchiveRemote {
	readonly destination: string;
	readonly supportsMirror = true;
	readonly mirrorHandleIsName = true;

	constructor(readonly config: Extract<RemoteConfig, { type: "rclone" }>) {
		this.destination = config.destination;
	}

	async indexExists(machine: string): Promise<boolean> {
		return await remoteFileExists(
			joinRcloneDestination(this.config.destination, `${machine}/index.jsonl.age`),
			this.config.rcloneConfig,
		);
	}

	async putArchiveObjects(_machine: string, sourceRoot: string, _onObject?: (key: string) => void): Promise<void> {
		await copyTree(sourceRoot, this.config.destination, this.config.rcloneConfig);
	}

	async putIndex(machine: string, sourcePath: string): Promise<void> {
		await copyFile(
			sourcePath,
			joinRcloneDestination(this.config.destination, `${machine}/index.jsonl.age`),
			this.config.rcloneConfig,
		);
	}

	async getIndex(machine: string, destinationPath: string): Promise<void> {
		await copyFile(
			joinRcloneDestination(this.config.destination, `${machine}/index.jsonl.age`),
			destinationPath,
			this.config.rcloneConfig,
		);
	}

	async getArchiveObject(machine: string, archivePath: string, destinationPath: string): Promise<void> {
		await copyFile(
			joinRcloneDestination(this.config.destination, `${machine}/${archivePath}.age`),
			destinationPath,
			this.config.rcloneConfig,
		);
	}

	async listMachines(): Promise<string[]> {
		return await listRemoteDirectories(this.config.destination, this.config.rcloneConfig);
	}

	async listMachineObjects(machine: string): Promise<string[]> {
		return (await listRemoteFiles(joinRcloneDestination(this.config.destination, machine), this.config.rcloneConfig))
			.filter((path) => path !== "index.jsonl.age" && path.endsWith(".age"))
			.map((path) => path.slice(0, -".age".length));
	}
}

const CLOUD_UPLOAD_CONCURRENCY = 8;

interface CloudRemoteState {
	v: 1;
	currentIndexEtag: string;
}

async function cloudState(path: string): Promise<CloudRemoteState | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof value === "object" &&
			value !== null &&
			(value as CloudRemoteState).v === 1 &&
			typeof (value as CloudRemoteState).currentIndexEtag === "string"
			? (value as CloudRemoteState)
			: null;
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) {
			return null;
		}
		throw error;
	}
}

async function archiveCiphertexts(sourceRoot: string, machine: string): Promise<Array<{ key: string; path: string }>> {
	const files: Array<{ key: string; path: string }> = [];
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile()) {
				const fromRoot = relative(sourceRoot, child);
				const prefix = `${machine}${sep}`;
				if (fromRoot.startsWith(prefix) && fromRoot !== `${machine}${sep}index.jsonl.age`) {
					files.push({ key: fromRoot.slice(prefix.length).split(sep).join("/"), path: child });
				}
			}
		}
	}
	await walk(sourceRoot);
	return files.sort((left, right) => left.key.localeCompare(right.key));
}

class CloudArchiveRemote implements ArchiveRemote {
	readonly destination: string;
	readonly supportsMirror = true;
	readonly mirrorHandleIsName = false;
	private sweepId = randomUUID();
	private expectedArchiveCount = 0;
	private mirrorHandles = new Set<string>();
	private readonly statePath: string;

	constructor(
		private readonly home: PackbatHome,
		readonly config: Extract<RemoteConfig, { type: "cloud" }>,
	) {
		this.destination = remoteDestination(config);
		this.statePath = join(remoteStatePath(home, config), "cloud.json");
	}

	private machineRemoteId(machine: string): string {
		return this.mirrorHandles.has(machine) ? machine : this.config.machineRemoteId;
	}

	async indexExists(machine: string): Promise<boolean> {
		return (await cloudDownloadUrl(this.home, this.machineRemoteId(machine), "index.jsonl.age")) !== null;
	}

	async putArchiveObjects(machine: string, sourceRoot: string, onObject?: (key: string) => void): Promise<void> {
		this.sweepId = randomUUID();
		const objects = await archiveCiphertexts(sourceRoot, machine);
		this.expectedArchiveCount = objects.length;
		let nextIndex = 0;
		let failure: { error: unknown } | undefined;
		const workers = Array.from({ length: Math.min(CLOUD_UPLOAD_CONCURRENCY, objects.length) }, async () => {
			while (failure === undefined) {
				const object = objects[nextIndex];
				nextIndex += 1;
				if (object === undefined) return;
				try {
					await uploadCloudObject({
						home: this.home,
						machineRemoteId: this.config.machineRemoteId,
						logicalObjectKey: object.key,
						path: object.path,
						sweepId: this.sweepId,
					});
					onObject?.(object.key);
				} catch (error) {
					failure ??= { error };
					return;
				}
			}
		});
		await Promise.all(workers);
		if (failure !== undefined) {
			throw failure.error;
		}
	}

	async putIndex(_machine: string, sourcePath: string): Promise<void> {
		const previous = await cloudState(this.statePath);
		const etag = await uploadCloudObject({
			home: this.home,
			machineRemoteId: this.config.machineRemoteId,
			logicalObjectKey: "index.jsonl.age",
			path: sourcePath,
			sweepId: this.sweepId,
			expectedArchiveCount: this.expectedArchiveCount,
			expectedIndexEtag: previous?.currentIndexEtag ?? null,
		});
		await writeAtomicJson(this.statePath, { v: 1, currentIndexEtag: etag });
	}

	async getIndex(machine: string, destinationPath: string): Promise<void> {
		await downloadCloudObject(this.home, this.machineRemoteId(machine), "index.jsonl.age", destinationPath);
	}

	async getArchiveObject(machine: string, archivePath: string, destinationPath: string): Promise<void> {
		const prefix = `${machine}${sep}`;
		const logicalKey = `${archivePath.startsWith(prefix) ? archivePath.slice(prefix.length) : archivePath}.age`
			.split(sep)
			.join("/");
		await downloadCloudObject(this.home, this.machineRemoteId(machine), logicalKey, destinationPath);
	}

	async listMachines(): Promise<string[]> {
		const handles = (await listCloudMachines(this.home))
			.map((machine) => machine.id)
			.filter((machineRemoteId) => machineRemoteId !== this.config.machineRemoteId);
		this.mirrorHandles = new Set(handles);
		return handles;
	}

	async listMachineObjects(machine: string): Promise<string[]> {
		return (await listCloudMachineObjects(this.home, this.machineRemoteId(machine)))
			.map((object) => object.key)
			.filter((key) => key !== "index.jsonl.age" && key.endsWith(".age"))
			.map((key) => key.slice(0, -".age".length));
	}
}

export function createArchiveRemote(home: PackbatHome, config: RemoteConfig): ArchiveRemote {
	switch (config.type) {
		case "rclone":
			return new RcloneArchiveRemote(config);
		case "cloud":
			return new CloudArchiveRemote(home, config);
	}
}
