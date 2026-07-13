import { execFile, spawn } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { BlotterError } from "../core/errors.js";
import { generateCronEntry, mergeCronTab, stripCronEntry } from "./cron.js";
import { generateLaunchdPlist, LAUNCHD_LABEL } from "./launchd.js";
import { generateSystemdService, generateSystemdTimer } from "./systemd.js";

const execFileAsync = promisify(execFile);
const SYSTEMD_SERVICE = "blotter-sync.service";
const SYSTEMD_TIMER = "blotter-sync.timer";

export interface ScheduleInstallOptions {
	userHome: string;
	statePath: string;
	logsPath: string;
	nodePath: string;
	entryPath: string;
	blotterHome?: string;
	env: NodeJS.ProcessEnv;
}

export interface ScheduleInstallResult {
	artifactPaths: string[];
	notes: string[];
}

export interface ScheduleUninstallOptions {
	userHome: string;
	statePath: string;
	env: NodeJS.ProcessEnv;
}

export interface ScheduleUninstallResult {
	removedPaths: string[];
}

export interface ScheduleActivationOptions {
	userHome: string;
	statePath: string;
	env: NodeJS.ProcessEnv;
}

type ScheduleKind = "launchd" | "systemd" | "cron";

function commandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (directory === "") {
			continue;
		}
		const candidate = join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return null;
}

function systemctlForRemoval(env: NodeJS.ProcessEnv): string | null {
	const fromPath = commandOnPath("systemctl", env);
	if (fromPath !== null) {
		return fromPath;
	}
	for (const candidate of ["/usr/bin/systemctl", "/bin/systemctl"]) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next standard location.
		}
	}
	return null;
}

function userId(): number {
	if (process.getuid === undefined) {
		throw new BlotterError("scheduler requires a POSIX user id");
	}
	return process.getuid();
}

function assertAbsoluteCommand(options: { nodePath: string; entryPath: string }): void {
	if (!isAbsolute(options.nodePath) || !isAbsolute(options.entryPath)) {
		throw new BlotterError("scheduler command paths must be absolute");
	}
}

async function runSchedulerCommand(command: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync(command, args, { encoding: "utf8" });
		return result.stdout;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new BlotterError(`scheduler command failed: ${command} ${args.join(" ")}: ${message}`);
	}
}

async function runIgnoringSchedulerFailure(command: string, args: string[]): Promise<void> {
	try {
		await execFileAsync(command, args);
	} catch {
		// Missing or unloaded jobs are expected during replacement and removal.
	}
}

async function readCrontab(crontab: string): Promise<string> {
	try {
		const result = await execFileAsync(crontab, ["-l"], { encoding: "utf8" });
		return result.stdout;
	} catch (error) {
		if ((error as { code?: unknown }).code === 1) {
			return "";
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new BlotterError(`scheduler command failed: ${crontab} -l: ${message}`);
	}
}

async function writeCrontab(crontab: string, contents: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(crontab, ["-"], { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new BlotterError(`scheduler command failed: ${crontab} -: ${stderr.trim() || `exit ${code}`}`));
		});
		child.stdin.end(contents);
	});
}

function launchdPath(userHome: string): string {
	return join(userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdPaths(userHome: string): { service: string; timer: string } {
	const directory = join(userHome, ".config", "systemd", "user");
	return { service: join(directory, SYSTEMD_SERVICE), timer: join(directory, SYSTEMD_TIMER) };
}

function systemdEnablementPath(userHome: string): string {
	return join(userHome, ".config", "systemd", "user", "timers.target.wants", SYSTEMD_TIMER);
}

function cronArtifactPath(statePath: string): string {
	return join(statePath, "schedule.cron");
}

function activationMarkerPath(statePath: string): string {
	return join(statePath, "schedule-activated");
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function installLaunchd(options: ScheduleInstallOptions): Promise<ScheduleInstallResult> {
	const path = launchdPath(options.userHome);
	await mkdir(join(options.userHome, "Library", "LaunchAgents"), { recursive: true });
	await writeFile(path, generateLaunchdPlist(options));
	return { artifactPaths: [path], notes: [] };
}

async function installSystemd(options: ScheduleInstallOptions): Promise<ScheduleInstallResult> {
	const paths = systemdPaths(options.userHome);
	await mkdir(join(options.userHome, ".config", "systemd", "user"), { recursive: true });
	await Promise.all([
		writeFile(paths.service, generateSystemdService(options)),
		writeFile(paths.timer, generateSystemdTimer()),
	]);
	return { artifactPaths: [paths.service, paths.timer], notes: [] };
}

async function installCron(options: ScheduleInstallOptions): Promise<ScheduleInstallResult> {
	const path = cronArtifactPath(options.statePath);
	await mkdir(options.statePath, { recursive: true });
	await writeFile(path, `${generateCronEntry(options)}\n`);
	return { artifactPaths: [path], notes: [] };
}

function scheduleKind(env: NodeJS.ProcessEnv): ScheduleKind {
	if (process.platform === "darwin") {
		return "launchd";
	}
	if (process.platform === "linux") {
		return commandOnPath("systemctl", env) === null ? "cron" : "systemd";
	}
	throw new BlotterError(`scheduling is not supported on ${process.platform}`);
}

export function previewSchedule(options: ScheduleInstallOptions): ScheduleInstallResult {
	assertAbsoluteCommand(options);
	switch (scheduleKind(options.env)) {
		case "launchd":
			return { artifactPaths: [launchdPath(options.userHome)], notes: [] };
		case "systemd": {
			const paths = systemdPaths(options.userHome);
			return { artifactPaths: [paths.service, paths.timer], notes: [] };
		}
		case "cron":
			return { artifactPaths: [cronArtifactPath(options.statePath)], notes: [] };
	}
}

export async function installSchedule(options: ScheduleInstallOptions): Promise<ScheduleInstallResult> {
	assertAbsoluteCommand(options);
	switch (scheduleKind(options.env)) {
		case "launchd":
			return await installLaunchd(options);
		case "systemd":
			return await installSystemd(options);
		case "cron":
			return await installCron(options);
	}
}

async function stripInstalledCron(statePath: string, env: NodeJS.ProcessEnv): Promise<void> {
	const crontab = commandOnPath("crontab", env);
	if (crontab !== null) {
		const current = await readCrontab(crontab);
		const stripped = stripCronEntry(current);
		if (stripped !== current) {
			await writeCrontab(crontab, stripped);
		}
	}
	await rm(cronArtifactPath(statePath), { force: true });
}

async function deactivateLaunchd(options: ScheduleActivationOptions): Promise<void> {
	if (!pathExists(launchdPath(options.userHome)) && !pathExists(activationMarkerPath(options.statePath))) {
		return;
	}
	await runIgnoringSchedulerFailure("launchctl", ["bootout", `gui/${userId()}/${LAUNCHD_LABEL}`]);
}

async function deactivateLinux(options: ScheduleActivationOptions): Promise<void> {
	const paths = systemdPaths(options.userHome);
	const enablementPath = systemdEnablementPath(options.userHome);
	const wasActivated = pathExists(activationMarkerPath(options.statePath));
	const hasSystemdArtifacts = [paths.service, paths.timer, enablementPath].some(pathExists);
	if (hasSystemdArtifacts && (wasActivated || pathExists(enablementPath))) {
		const systemctl = systemctlForRemoval(options.env);
		if (systemctl === null) {
			if (pathExists(enablementPath)) {
				throw new BlotterError("cannot deactivate the enabled systemd timer because systemctl is unavailable");
			}
		} else if (pathExists(enablementPath)) {
			await runSchedulerCommand(systemctl, ["--user", "disable", "--now", SYSTEMD_TIMER]);
		} else {
			await runIgnoringSchedulerFailure(systemctl, ["--user", "disable", "--now", SYSTEMD_TIMER]);
		}
	}
	if (wasActivated && pathExists(cronArtifactPath(options.statePath))) {
		const crontab = commandOnPath("crontab", options.env);
		if (crontab === null) {
			throw new BlotterError("cannot deactivate the installed cron schedule because crontab is unavailable");
		}
		const current = await readCrontab(crontab);
		const stripped = stripCronEntry(current);
		if (stripped !== current) {
			await writeCrontab(crontab, stripped);
		}
	}
}

export async function deactivateSchedule(options: ScheduleActivationOptions): Promise<void> {
	if (process.platform === "darwin") {
		await deactivateLaunchd(options);
		await rm(activationMarkerPath(options.statePath), { force: true });
		return;
	}
	if (process.platform === "linux") {
		await deactivateLinux(options);
		await rm(activationMarkerPath(options.statePath), { force: true });
		return;
	}
	throw new BlotterError(`scheduling is not supported on ${process.platform}`);
}

async function activateLaunchd(options: ScheduleActivationOptions): Promise<string[]> {
	const path = launchdPath(options.userHome);
	const domain = `gui/${userId()}`;
	await runIgnoringSchedulerFailure("launchctl", ["bootout", domain, path]);
	await runSchedulerCommand("launchctl", ["bootstrap", domain, path]);
	return [];
}

async function activateSystemd(options: ScheduleActivationOptions, systemctl: string): Promise<string[]> {
	await runSchedulerCommand(systemctl, ["--user", "daemon-reload"]);
	await runSchedulerCommand(systemctl, ["--user", "enable", "--now", SYSTEMD_TIMER]);
	await stripInstalledCron(options.statePath, options.env);
	const notes: string[] = [];
	const loginctl = commandOnPath("loginctl", options.env);
	if (loginctl !== null) {
		try {
			const linger = await runSchedulerCommand(loginctl, ["show-user", String(userId()), "-p", "Linger"]);
			if (!/^Linger=yes$/m.test(linger)) {
				notes.push("note: systemd linger is off; scheduled sync resumes at the next login");
			}
		} catch {
			// Linger is advisory and must never block installation.
		}
	}
	return notes;
}

async function activateCron(options: ScheduleActivationOptions): Promise<string[]> {
	const crontab = commandOnPath("crontab", options.env);
	if (crontab === null) {
		throw new BlotterError("no supported scheduler found (systemctl and crontab are unavailable)");
	}
	const entry = (await readFile(cronArtifactPath(options.statePath), "utf8")).trimEnd();
	const current = await readCrontab(crontab);
	await writeCrontab(crontab, mergeCronTab(current, entry));
	const paths = systemdPaths(options.userHome);
	await Promise.all(
		[paths.service, paths.timer, systemdEnablementPath(options.userHome)].map(
			async (path) => await rm(path, { force: true }),
		),
	);
	return [];
}

export async function activateSchedule(options: ScheduleActivationOptions): Promise<string[]> {
	let notes: string[];
	if (process.platform === "darwin") {
		notes = await activateLaunchd(options);
	} else if (process.platform === "linux") {
		const systemctl = commandOnPath("systemctl", options.env);
		notes = systemctl === null ? await activateCron(options) : await activateSystemd(options, systemctl);
	} else {
		throw new BlotterError(`scheduling is not supported on ${process.platform}`);
	}
	await mkdir(options.statePath, { recursive: true });
	await writeFile(activationMarkerPath(options.statePath), "active\n");
	return notes;
}

export function scheduleWasActivated(statePath: string): boolean {
	return pathExists(activationMarkerPath(statePath));
}

async function uninstallLaunchd(options: ScheduleUninstallOptions): Promise<ScheduleUninstallResult> {
	const path = launchdPath(options.userHome);
	const cronPath = cronArtifactPath(options.statePath);
	const markerPath = activationMarkerPath(options.statePath);
	const removedPaths = [path, cronPath, markerPath].filter(pathExists);
	if (pathExists(markerPath)) {
		await runIgnoringSchedulerFailure("launchctl", ["bootout", `gui/${userId()}/${LAUNCHD_LABEL}`]);
	}
	await Promise.all(removedPaths.map(async (artifactPath) => await rm(artifactPath, { force: true })));
	return { removedPaths };
}

async function uninstallLinux(options: ScheduleUninstallOptions): Promise<ScheduleUninstallResult> {
	const paths = systemdPaths(options.userHome);
	const cronPath = cronArtifactPath(options.statePath);
	const present = [
		paths.service,
		paths.timer,
		systemdEnablementPath(options.userHome),
		cronPath,
		activationMarkerPath(options.statePath),
	].filter(pathExists);
	const crontab = commandOnPath("crontab", options.env);
	let hadCronEntry = false;
	if (crontab !== null) {
		const current = await readCrontab(crontab);
		hadCronEntry = stripCronEntry(current) !== current;
	}
	await deactivateLinux(options);
	const systemctl = systemctlForRemoval(options.env);
	await Promise.all(present.map(async (path) => await rm(path, { force: true })));
	const removedPaths = [...present];
	if (crontab !== null) {
		const current = await readCrontab(crontab);
		const stripped = stripCronEntry(current);
		if (stripped !== current) {
			await writeCrontab(crontab, stripped);
		}
		if (hadCronEntry) {
			removedPaths.push("crontab (# blotter-sync)");
		}
	}
	if (systemctl !== null) {
		await runIgnoringSchedulerFailure(systemctl, ["--user", "daemon-reload"]);
	}
	return { removedPaths };
}

export async function uninstallSchedule(options: ScheduleUninstallOptions): Promise<ScheduleUninstallResult> {
	if (process.platform === "darwin") {
		return await uninstallLaunchd(options);
	}
	if (process.platform === "linux") {
		return await uninstallLinux(options);
	}
	throw new BlotterError(`scheduling is not supported on ${process.platform}`);
}
