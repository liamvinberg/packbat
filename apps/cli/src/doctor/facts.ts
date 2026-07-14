import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { HarnessId } from "../adapters/adapter.js";
import { adapters, unsupportedStores } from "../adapters/registry.js";
import { type BlotterConfig, type RemoteConfig, remoteStatePath } from "../core/config.js";
import { commandOnPath } from "../core/exec.js";
import { isEnoent, pathExists } from "../core/fs.js";
import type { BlotterHome } from "../core/home.js";
import { readDerivedIndex } from "../core/index.js";
import type { RunStamp } from "../core/stamps.js";
import { CRON_MARKER, generateCronEntry } from "../schedule/cron.js";
import { generateLaunchdPlist, LAUNCHD_LABEL } from "../schedule/launchd.js";
import { generateSystemdService, generateSystemdTimer } from "../schedule/systemd.js";

const MINIMUM_FREE_BYTES = 500 * 1024 * 1024;
const SYSTEMD_SERVICE = "blotter-sync.service";
const SYSTEMD_TIMER = "blotter-sync.timer";

export interface Fact {
	id: string;
	title: string;
	status: "ok" | "problem" | "info";
	detail: string;
	data?: unknown;
}

export interface DoctorContext {
	config: BlotterConfig;
	home: BlotterHome;
	userHome: string;
	env: NodeJS.ProcessEnv;
	now: Date;
}

export type ScheduleKind = "launchd" | "systemd" | "cron";

export interface InstalledSchedule {
	kind: ScheduleKind;
	artifactPaths: string[];
	nodePath: string;
	entryPath: string;
}

export interface InstalledCheck {
	fact: Fact;
	schedule: InstalledSchedule | null;
}

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export type StampRead =
	| { kind: "missing" }
	| { kind: "invalid"; detail: string }
	| { kind: "value"; value: RunStamp; finishedAtMs: number };

export interface FreshCheck {
	fact: Fact;
	lastRun: StampRead;
	lastSuccess: StampRead;
}

export interface HarnessTally {
	harness: HarnessId;
	units: number;
	files: number;
	storedBytes: number;
}

function fact(id: string, status: Fact["status"], detail: string, data?: unknown): Fact {
	return { id, title: id, status, detail, ...(data === undefined ? {} : { data }) };
}

export function createDoctorContext(
	config: BlotterConfig,
	home: BlotterHome,
	env: NodeJS.ProcessEnv = process.env,
	now: Date = new Date(),
): DoctorContext {
	const configuredHome = env.HOME?.trim();
	return { config, home, userHome: configuredHome ? configuredHome : homedir(), env, now };
}

async function command(commandPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
	return await new Promise((resolve) => {
		execFile(commandPath, args, { encoding: "utf8", env }, (error, stdout, stderr) => {
			resolve({ ok: error === null, stdout, stderr });
		});
	});
}

function decodeXml(value: string): string {
	return value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function launchdArguments(contents: string): string[] | null {
	const section = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents)?.[1];
	if (section === undefined) {
		return null;
	}
	return [...section.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => decodeXml(match[1] ?? ""));
}

function launchdEnvironment(contents: string): Map<string, string> | null {
	const marker = "<key>EnvironmentVariables</key>";
	if (!contents.includes(marker)) {
		return new Map();
	}
	const section = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(contents)?.[1];
	if (section === undefined) {
		return null;
	}
	const pairPattern = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
	if (section.replace(pairPattern, "").trim() !== "") {
		return null;
	}
	return new Map(
		[...section.matchAll(pairPattern)].map((match) => [decodeXml(match[1] ?? ""), decodeXml(match[2] ?? "")]),
	);
}

function decodeSystemdValue(value: string): string {
	return value.replaceAll("%%", "%").replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function systemdArguments(contents: string): string[] | null {
	const line = /^ExecStart=(.+)$/m.exec(contents)?.[1];
	if (line === undefined) {
		return null;
	}
	const values = [...line.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => decodeSystemdValue(match[1] ?? ""));
	return values.length === 3 ? values : null;
}

function systemdEnvironment(contents: string): Map<string, string> | null {
	const environment = new Map<string, string>();
	for (const line of contents.split("\n")) {
		if (!line.startsWith("Environment=")) {
			continue;
		}
		const encoded = /^Environment="((?:\\.|[^"])*)"$/.exec(line)?.[1];
		if (encoded === undefined) {
			return null;
		}
		const assignment = decodeSystemdValue(encoded);
		const separator = assignment.indexOf("=");
		if (separator <= 0) {
			return null;
		}
		environment.set(assignment.slice(0, separator), assignment.slice(separator + 1));
	}
	return environment;
}

interface QuotedToken {
	value: string;
	next: number;
}

function shellQuotedToken(input: string, start: number): QuotedToken | null {
	if (input[start] !== "'") {
		return null;
	}
	let value = "";
	let index = start + 1;
	while (index < input.length) {
		if (input.startsWith(`'"'"'`, index)) {
			value += "'";
			index += 5;
			continue;
		}
		const character = input[index];
		if (character === "'") {
			return { value: value.replaceAll("\\%", "%"), next: index + 1 };
		}
		value += character;
		index += 1;
	}
	return null;
}

function cronArguments(
	contents: string,
): { nodePath: string; entryPath: string; environment: Map<string, string> } | null {
	const line = contents.trimEnd();
	const prefix = "3 * * * * ";
	if (!line.startsWith(prefix) || !line.endsWith(` ${CRON_MARKER}`)) {
		return null;
	}
	let index = prefix.length;
	const environment = new Map<string, string>();
	while (true) {
		const assignment = /^([A-Z][A-Z0-9_]*)=/.exec(line.slice(index));
		const key = assignment?.[1];
		if (assignment === null || key === undefined) {
			break;
		}
		index += assignment[0].length;
		const value = shellQuotedToken(line, index);
		if (value === null || line[value.next] !== " ") {
			return null;
		}
		environment.set(key, value.value);
		index = value.next + 1;
	}
	const node = shellQuotedToken(line, index);
	if (node === null || line[node.next] !== " ") {
		return null;
	}
	const entry = shellQuotedToken(line, node.next + 1);
	if (entry === null || line[entry.next] !== " ") {
		return null;
	}
	const sync = shellQuotedToken(line, entry.next + 1);
	if (sync === null || sync.value !== "sync" || line.slice(sync.next) !== ` ${CRON_MARKER}`) {
		return null;
	}
	return { nodePath: node.value, entryPath: entry.value, environment };
}

async function executablePathsExist(nodePath: string, entryPath: string): Promise<string[]> {
	const missing: string[] = [];
	for (const path of [nodePath, entryPath]) {
		try {
			await access(path, constants.F_OK);
		} catch {
			missing.push(path);
		}
	}
	return missing;
}

function installedData(schedule: InstalledSchedule): unknown {
	return {
		kind: schedule.kind,
		artifactPaths: schedule.artifactPaths,
		nodePath: schedule.nodePath,
		entryPath: schedule.entryPath,
	};
}

async function checkLaunchdInstalled(context: DoctorContext): Promise<InstalledCheck> {
	const artifactPath = join(context.userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
	let contents: string;
	try {
		contents = await readFile(artifactPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { fact: fact("installed", "problem", `missing ${artifactPath}`), schedule: null };
		}
		return { fact: fact("installed", "problem", `cannot read ${artifactPath}`), schedule: null };
	}
	const args = launchdArguments(contents);
	const environment = launchdEnvironment(contents);
	if (args === null || environment === null || args.length !== 3 || args[2] !== "sync") {
		return { fact: fact("installed", "problem", "launchd artifact does not match blotter's schedule"), schedule: null };
	}
	const nodePath = args[0] ?? "";
	const entryPath = args[1] ?? "";
	const expected = generateLaunchdPlist({
		nodePath,
		entryPath,
		logsPath: context.home.logsPath,
		environment,
	});
	const schedule: InstalledSchedule = { kind: "launchd", artifactPaths: [artifactPath], nodePath, entryPath };
	if (contents !== expected) {
		return {
			fact: fact("installed", "problem", "launchd artifact does not match blotter's schedule", installedData(schedule)),
			schedule,
		};
	}
	const missingPaths = await executablePathsExist(nodePath, entryPath);
	if (missingPaths.length > 0) {
		return {
			fact: fact("installed", "problem", `scheduled path missing: ${missingPaths.join(", ")}`, installedData(schedule)),
			schedule,
		};
	}
	return { fact: fact("installed", "ok", "launchd schedule matches", installedData(schedule)), schedule };
}

function systemdArtifactPaths(userHome: string): { service: string; timer: string } {
	const root = join(userHome, ".config", "systemd", "user");
	return { service: join(root, SYSTEMD_SERVICE), timer: join(root, SYSTEMD_TIMER) };
}

async function checkSystemdInstalled(context: DoctorContext): Promise<InstalledCheck> {
	const paths = systemdArtifactPaths(context.userHome);
	let service: string;
	let timer: string;
	try {
		[service, timer] = await Promise.all([readFile(paths.service, "utf8"), readFile(paths.timer, "utf8")]);
	} catch {
		return {
			fact: fact("installed", "problem", `missing or unreadable ${SYSTEMD_SERVICE} / ${SYSTEMD_TIMER}`),
			schedule: null,
		};
	}
	const args = systemdArguments(service);
	const environment = systemdEnvironment(service);
	if (args === null || environment === null || args[2] !== "sync") {
		return { fact: fact("installed", "problem", "systemd artifacts do not match blotter's schedule"), schedule: null };
	}
	const nodePath = args[0] ?? "";
	const entryPath = args[1] ?? "";
	const schedule: InstalledSchedule = {
		kind: "systemd",
		artifactPaths: [paths.service, paths.timer],
		nodePath,
		entryPath,
	};
	const expectedService = generateSystemdService({
		nodePath,
		entryPath,
		environment,
	});
	if (service !== expectedService || timer !== generateSystemdTimer()) {
		return {
			fact: fact("installed", "problem", "systemd artifacts do not match blotter's schedule", installedData(schedule)),
			schedule,
		};
	}
	const missingPaths = await executablePathsExist(nodePath, entryPath);
	if (missingPaths.length > 0) {
		return {
			fact: fact("installed", "problem", `scheduled path missing: ${missingPaths.join(", ")}`, installedData(schedule)),
			schedule,
		};
	}
	return { fact: fact("installed", "ok", "systemd schedule matches", installedData(schedule)), schedule };
}

async function checkCronInstalled(context: DoctorContext): Promise<InstalledCheck> {
	const artifactPath = join(context.home.statePath, "schedule.cron");
	let contents: string;
	try {
		contents = await readFile(artifactPath, "utf8");
	} catch {
		return { fact: fact("installed", "problem", `missing or unreadable ${artifactPath}`), schedule: null };
	}
	const args = cronArguments(contents);
	if (args === null) {
		return { fact: fact("installed", "problem", "cron artifact does not match blotter's schedule"), schedule: null };
	}
	const schedule: InstalledSchedule = {
		kind: "cron",
		artifactPaths: [artifactPath],
		nodePath: args.nodePath,
		entryPath: args.entryPath,
	};
	const expected = `${generateCronEntry({
		nodePath: args.nodePath,
		entryPath: args.entryPath,
		environment: args.environment,
	})}\n`;
	if (contents !== expected) {
		return {
			fact: fact("installed", "problem", "cron artifact does not match blotter's schedule", installedData(schedule)),
			schedule,
		};
	}
	const missingPaths = await executablePathsExist(args.nodePath, args.entryPath);
	if (missingPaths.length > 0) {
		return {
			fact: fact("installed", "problem", `scheduled path missing: ${missingPaths.join(", ")}`, installedData(schedule)),
			schedule,
		};
	}
	return { fact: fact("installed", "ok", "cron schedule matches", installedData(schedule)), schedule };
}

export async function checkInstalled(context: DoctorContext): Promise<InstalledCheck> {
	if (process.platform === "darwin") {
		return await checkLaunchdInstalled(context);
	}
	if (process.platform === "linux") {
		const paths = systemdArtifactPaths(context.userHome);
		const hasSystemdArtifact = pathExists(paths.service) || pathExists(paths.timer);
		const hasCronArtifact = pathExists(join(context.home.statePath, "schedule.cron"));
		if (hasSystemdArtifact && !hasCronArtifact) {
			return await checkSystemdInstalled(context);
		}
		if (hasCronArtifact && !hasSystemdArtifact) {
			return await checkCronInstalled(context);
		}
		return commandOnPath("systemctl", context.env) !== null
			? await checkSystemdInstalled(context)
			: await checkCronInstalled(context);
	}
	return {
		fact: fact("installed", "problem", `scheduling is not supported on ${process.platform}`),
		schedule: null,
	};
}

function parseLaunchdExitStatus(output: string): number | null {
	const match = /last exit (?:code|status)\s*=\s*(-?\d+)/i.exec(output);
	if (match?.[1] === undefined) {
		return null;
	}
	const value = Number.parseInt(match[1], 10);
	return Number.isNaN(value) ? null : value;
}

function parseLaunchdArtifactPath(output: string): string | null {
	return /^\s*path\s*=\s*(.+?)\s*$/im.exec(output)?.[1] ?? null;
}

async function checkLaunchdLive(context: DoctorContext, schedule: InstalledSchedule): Promise<Fact> {
	if (process.getuid === undefined) {
		return fact("live", "problem", "launchd user domain is unavailable");
	}
	const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
	const result = await command("launchctl", ["print", target], context.env);
	if (!result.ok) {
		return fact("live", "problem", `launchd job is not loaded (${target})`);
	}
	const expectedPath = schedule.artifactPaths[0] ?? "";
	const loadedPath = parseLaunchdArtifactPath(result.stdout);
	if (loadedPath === null) {
		return fact("live", "problem", `launchd job artifact path is unavailable; expected ${expectedPath}`, {
			expectedPath,
		});
	}
	if (loadedPath !== expectedPath) {
		return fact("live", "problem", `launchd job is loaded from ${loadedPath}; expected ${expectedPath}`, {
			loadedPath,
			expectedPath,
		});
	}
	const exitStatus = parseLaunchdExitStatus(result.stdout);
	if (exitStatus === null) {
		return fact("live", "info", "loaded, state unverified");
	}
	return exitStatus === 0
		? fact("live", "ok", "loaded, last exit 0", { exitStatus })
		: fact("live", "problem", `loaded, last exit ${exitStatus}`, { exitStatus });
}

function parseProperties(contents: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const line of contents.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) {
			properties[line.slice(0, separator)] = line.slice(separator + 1);
		}
	}
	return properties;
}

async function checkSystemdLive(context: DoctorContext): Promise<Fact> {
	const result = await command(
		"systemctl",
		["--user", "show", SYSTEMD_TIMER, "--property=LoadState,UnitFileState,ActiveState"],
		context.env,
	);
	if (!result.ok) {
		return fact("live", "problem", `${SYSTEMD_TIMER} could not be inspected`);
	}
	const properties = parseProperties(result.stdout);
	const expected = { LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active" };
	const problems = Object.entries(expected)
		.filter(([key, value]) => properties[key] !== value)
		.map(([key, value]) => `${key}=${properties[key] ?? "missing"} (want ${value})`);
	return problems.length === 0
		? fact("live", "ok", "systemd timer is loaded, enabled, active", properties)
		: fact("live", "problem", problems.join(", "), properties);
}

async function checkCronLive(context: DoctorContext): Promise<Fact> {
	const result = await command("crontab", ["-l"], context.env);
	if (!result.ok) {
		return fact("live", "problem", "blotter marker is absent from crontab");
	}
	const present = result.stdout.split("\n").some((line) => line.trimEnd().endsWith(CRON_MARKER));
	return present
		? fact("live", "info", "cron marker is present; cron cannot prove execution")
		: fact("live", "problem", "blotter marker is absent from crontab");
}

export async function checkLive(
	context: DoctorContext,
	installed: InstalledCheck,
	options: { probe: boolean } = { probe: true },
): Promise<Fact> {
	if (!options.probe) {
		return fact("live", "info", "live state not checked; run `blotter doctor`");
	}
	if (installed.schedule === null) {
		return fact("live", "problem", "schedule state cannot be checked until it is installed");
	}
	switch (installed.schedule.kind) {
		case "launchd":
			return await checkLaunchdLive(context, installed.schedule);
		case "systemd":
			return await checkSystemdLive(context);
		case "cron":
			return await checkCronLive(context);
	}
}

function isRunStamp(value: unknown): value is RunStamp {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.startedAt === "string" &&
		typeof record.finishedAt === "string" &&
		typeof record.ok === "boolean" &&
		typeof record.archived === "number" &&
		typeof record.unchanged === "number" &&
		typeof record.failed === "number" &&
		(record.repaired === undefined || typeof record.repaired === "number")
	);
}

async function readStamp(path: string): Promise<StampRead> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { kind: "missing" };
		}
		return { kind: "invalid", detail: "unreadable" };
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRunStamp(value)) {
			return { kind: "invalid", detail: "invalid shape" };
		}
		const finishedAtMs = Date.parse(value.finishedAt);
		return Number.isNaN(finishedAtMs)
			? { kind: "invalid", detail: "invalid finishedAt" }
			: { kind: "value", value, finishedAtMs };
	} catch {
		return { kind: "invalid", detail: "invalid JSON" };
	}
}

export function windowMs(context: DoctorContext): number {
	return context.config.sweep.intervalMinutes * 2 * 60 * 1000;
}

export function ageMs(timestampMs: number, now: Date): number {
	return Math.max(0, now.getTime() - timestampMs);
}

export function formatAge(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return `${hours}h ago`;
	}
	return `${Math.floor(hours / 24)}d ago`;
}

export async function checkFresh(context: DoctorContext): Promise<FreshCheck> {
	const [lastRun, lastSuccess] = await Promise.all([
		readStamp(join(context.home.statePath, "last-run.json")),
		readStamp(join(context.home.statePath, "last-success.json")),
	]);
	if (lastSuccess.kind === "missing") {
		return { fact: fact("fresh", "problem", "never succeeded"), lastRun, lastSuccess };
	}
	if (lastSuccess.kind === "invalid") {
		return {
			fact: fact("fresh", "problem", `last-success is ${lastSuccess.detail}`),
			lastRun,
			lastSuccess,
		};
	}
	const successAgeMs = ageMs(lastSuccess.finishedAtMs, context.now);
	const fresh = successAgeMs < windowMs(context);
	if (fresh) {
		return {
			fact: fact("fresh", "ok", `last success ${formatAge(successAgeMs)}`, { lastSuccess: lastSuccess.value }),
			lastRun,
			lastSuccess,
		};
	}
	let detail = `last success ${formatAge(successAgeMs)}`;
	if (lastRun.kind === "value" && !lastRun.value.ok && ageMs(lastRun.finishedAtMs, context.now) < windowMs(context)) {
		detail += `; latest run failed ${formatAge(ageMs(lastRun.finishedAtMs, context.now))}`;
	}
	return {
		fact: fact("fresh", "problem", detail, { lastSuccess: lastSuccess.value }),
		lastRun,
		lastSuccess,
	};
}

export function retentionFact(): Fact {
	const risks = adapters.flatMap((adapter) =>
		adapter.retentionRisk === null
			? []
			: [
					{
						harness: adapter.id,
						risk: adapter.retentionRisk,
					},
				],
	);
	return fact(
		"retention",
		"info",
		// DRAFT copy
		risks
			.map(({ harness, risk }) => `${harness}: ${risk.replace(/\.$/, "")}; the hourly sweep stays ahead of it`)
			.join("\n"),
		{ risks },
	);
}

async function unsupportedStoreFacts(context: DoctorContext): Promise<Fact[]> {
	const facts: Fact[] = [];
	for (const store of unsupportedStores) {
		const path = store.detect(context.env, context.userHome);
		if (path !== null) {
			facts.push(fact(`unsupported-${store.id}`, "info", `found ${store.id} at ${path} — not yet supported`, { path }));
		}
	}
	return facts;
}

async function storeReadabilityFact(context: DoctorContext): Promise<Fact> {
	const unreadable: string[] = [];
	const present: string[] = [];
	for (const adapter of adapters) {
		const path = adapter.storeRoot(context.env, context.userHome);
		try {
			await access(path, constants.F_OK);
			present.push(path);
			await access(path, constants.R_OK);
		} catch (error) {
			if (!isEnoent(error)) {
				unreadable.push(path);
			}
		}
	}
	return unreadable.length === 0
		? fact(
				"stores-readable",
				"ok",
				`${present.length} existing source store${present.length === 1 ? " is" : "s are"} readable`,
				{
					present,
				},
			)
		: fact("stores-readable", "problem", `unreadable: ${unreadable.join(", ")}`, { present, unreadable });
}

async function archiveWritableFact(context: DoctorContext): Promise<Fact> {
	const probePath = join(context.config.archiveRoot, `.blotter-doctor-${process.pid}-${randomUUID()}`);
	try {
		await mkdir(context.config.archiveRoot, { recursive: true });
		await writeFile(probePath, "blotter doctor\n");
		await rm(probePath);
		return fact("archive-writable", "ok", `writable: ${context.config.archiveRoot}`);
	} catch (error) {
		await rm(probePath, { force: true }).catch(() => undefined);
		return fact(
			"archive-writable",
			"problem",
			`cannot write ${context.config.archiveRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function diskHeadroomFact(context: DoctorContext): Promise<Fact> {
	try {
		const stats = await statfs(context.config.archiveRoot);
		const freeBytes = stats.bavail * stats.bsize;
		const freeMiB = Math.floor(freeBytes / 1024 / 1024);
		return freeBytes < MINIMUM_FREE_BYTES
			? fact("disk-headroom", "problem", `${freeMiB} MiB free; need at least 500 MiB`, { freeBytes })
			: fact("disk-headroom", "ok", `${freeMiB} MiB free`, { freeBytes });
	} catch (error) {
		return fact(
			"disk-headroom",
			"problem",
			`cannot inspect ${context.config.archiveRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function compressionFact(): Fact {
	try {
		if (typeof zlib.zstdCompressSync !== "function" || typeof zlib.zstdDecompressSync !== "function") {
			throw new Error("zstd is unavailable");
		}
		const source = Buffer.from("blotter compression smoke\n", "utf8");
		const restored = zlib.zstdDecompressSync(zlib.zstdCompressSync(source));
		if (!restored.equals(source)) {
			throw new Error("round-trip mismatch");
		}
		return fact("compression", "ok", "zstd round-trip passed");
	} catch (error) {
		return fact(
			"compression",
			"problem",
			`zstd round-trip failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function checkRemoteOffbox(context: DoctorContext, remote: RemoteConfig): Promise<Fact> {
	const prefix = `${remote.destination} · `; // DRAFT copy
	const path = join(remoteStatePath(context.home, remote), "last-success.json");
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isEnoent(error)) {
			return fact("offbox", "problem", `${prefix}off-box has never succeeded`); // DRAFT copy
		}
		return fact("offbox", "problem", `${prefix}last-success is unreadable or invalid`); // DRAFT copy
	}
	const rawFinishedAt =
		typeof value === "object" && value !== null ? (value as Record<string, unknown>).finishedAt : undefined;
	const finishedAt = typeof rawFinishedAt === "string" ? rawFinishedAt : null;
	const finishedAtMs = finishedAt === null ? Number.NaN : Date.parse(finishedAt);
	if (Number.isNaN(finishedAtMs)) {
		return fact("offbox", "problem", `${prefix}last-success has an invalid finishedAt`); // DRAFT copy
	}
	const elapsed = ageMs(finishedAtMs, context.now);
	// DRAFT copy
	return elapsed < windowMs(context)
		? fact("offbox", "ok", `${prefix}last off-box success ${formatAge(elapsed)}`, {
				finishedAt,
				destination: remote.destination,
			})
		: fact("offbox", "problem", `${prefix}last off-box success ${formatAge(elapsed)}`, {
				finishedAt,
				destination: remote.destination,
			});
}

export async function checkOffbox(context: DoctorContext): Promise<Fact[]> {
	if (context.config.offbox.mode === "skipped") {
		return [fact("offbox", "info", `off-box skipped on ${context.config.offbox.skippedAt.slice(0, 10)}`)];
	}
	return await Promise.all(
		context.config.offbox.remotes.map(async (remote) => await checkRemoteOffbox(context, remote)),
	);
}

export async function collectEnvironmentFacts(context: DoctorContext): Promise<Fact[]> {
	const unsupported = await unsupportedStoreFacts(context);
	const readable = await storeReadabilityFact(context);
	const writable = await archiveWritableFact(context);
	const disk = await diskHeadroomFact(context);
	const compression = compressionFact();
	const offbox = await checkOffbox(context);
	return [...unsupported, readable, writable, disk, compression, ...offbox];
}

export async function readHarnessTallies(context: DoctorContext): Promise<HarnessTally[]> {
	const machineRoot = join(context.config.archiveRoot, context.config.machine);
	const index = await readDerivedIndex(machineRoot, context.config.machine);
	return adapters.map((adapter) => {
		const records = [...index.records.values()].filter((record) => record.harness === adapter.id);
		return {
			harness: adapter.id,
			units: new Set(records.map((record) => record.unit)).size,
			files: records.length,
			storedBytes: records.reduce((sum, record) => sum + record.storedSize, 0),
		};
	});
}

export function remedyForFact(item: Fact): string {
	if (item.id === "installed") {
		return "re-run `blotter init`";
	}
	if (item.id === "live") {
		return "re-run `blotter init` and inspect the scheduler";
	}
	if (item.id === "fresh") {
		return "run `blotter sync` and inspect the log; Claude Code's 30-day cleanup keeps running while sweeps fail";
	}
	if (item.id === "reconciled") {
		return "run `blotter sync`";
	}
	if (item.id === "stores-readable") {
		return "fix read access to the listed store roots";
	}
	if (item.id === "archive-writable") {
		return "fix write access to the archive root";
	}
	if (item.id === "disk-headroom") {
		return "free at least 500 MiB at the archive root";
	}
	if (item.id === "compression") {
		return "use Node 22.15 or newer";
	}
	if (item.id === "offbox") {
		return "run the off-box sync and inspect its log";
	}
	return "inspect this check and retry";
}
