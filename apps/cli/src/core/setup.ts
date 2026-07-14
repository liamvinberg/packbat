import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { adapters, unsupportedStores } from "../adapters/registry.js";
import { scheduleEnvironment } from "../schedule/environment.js";
import {
	activateSchedule,
	deactivateSchedule,
	installSchedule,
	type ScheduleInstallOptions,
	type ScheduleInstallResult,
	scheduleWasActivated,
} from "../schedule/scheduler.js";
import { CONFIG_VERSION, loadConfig, type OffboxConfig, type PackbatConfig, saveConfig } from "./config.js";
import { PackbatError } from "./errors.js";
import type { PackbatHome } from "./home.js";
import { defaultMachineName } from "./machine.js";

export interface InitDetection {
	detected: Array<{ displayName: string; path: string }>;
	unsupported: Array<{ displayName: string; path: string }>;
}

export interface InstalledInitSchedule {
	schedule: ScheduleInstallResult;
	activationNotes: string[];
}

export function skippedOffboxConfig(): OffboxConfig {
	return { mode: "skipped", skippedAt: new Date().toISOString() };
}

export function userHome(): string {
	const configured = process.env.HOME?.trim();
	return configured ? configured : homedir();
}

export function detectInitStores(homePath: string): InitDetection {
	return {
		detected: adapters
			.map((adapter) => ({ displayName: adapter.displayName, path: adapter.storeRoot(process.env, homePath) }))
			.filter(({ path }) => existsSync(path)),
		unsupported: unsupportedStores
			.map((store) => ({ displayName: store.displayName, path: store.detect(process.env, homePath) }))
			.filter((entry): entry is { displayName: string; path: string } => entry.path !== null),
	};
}

export async function writeInitConfig(
	home: PackbatHome,
	archiveRoot: string,
	offbox?: OffboxConfig,
): Promise<PackbatConfig> {
	if (!isAbsolute(archiveRoot)) {
		throw new PackbatError("archive root must be absolute");
	}
	let config: PackbatConfig;
	if (existsSync(home.configPath)) {
		config = loadConfig(home);
		if (archiveRoot !== config.archiveRoot) {
			throw new PackbatError(`archive root is already ${config.archiveRoot}; edit config.json to move the archive`);
		}
		if (offbox !== undefined) {
			config = { ...config, offbox };
		}
	} else {
		config = {
			version: CONFIG_VERSION,
			machine: defaultMachineName(),
			archiveRoot,
			sweep: { intervalMinutes: 60 },
			offbox: offbox ?? skippedOffboxConfig(),
		};
	}
	saveConfig(home, config);
	await Promise.all([
		mkdir(home.statePath, { recursive: true }),
		mkdir(home.logsPath, { recursive: true }),
		mkdir(config.archiveRoot, { recursive: true }),
	]);
	return config;
}

export async function createInitScheduleOptions(home: PackbatHome, homePath: string): Promise<ScheduleInstallOptions> {
	const entryArgument = process.argv[1];
	if (entryArgument === undefined) {
		throw new Error("CLI entry path is unavailable");
	}
	return {
		userHome: homePath,
		statePath: home.statePath,
		logsPath: home.logsPath,
		nodePath: process.execPath,
		entryPath: await realpath(entryArgument),
		environment: scheduleEnvironment(process.env),
		env: process.env,
	};
}

export async function installInitSchedule(
	options: ScheduleInstallOptions,
	activate: boolean,
): Promise<InstalledInitSchedule> {
	if (activate || scheduleWasActivated(options.statePath)) {
		await deactivateSchedule(options);
	}
	const schedule = await installSchedule(options);
	const activationNotes = activate ? await activateSchedule(options) : [];
	return { schedule, activationNotes };
}
