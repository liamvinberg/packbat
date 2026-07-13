import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, spinner, text } from "@clack/prompts";
import { type BlotterConfig, loadConfig, type OffboxConfig } from "../core/config.js";
import { resolveHome } from "../core/home.js";
import {
	createInitScheduleOptions,
	detectInitStores,
	installInitSchedule,
	skippedOffboxConfig,
	userHome,
	writeInitConfig,
} from "../core/setup.js";
import { generateIdentity, identityToRecipient } from "../offbox/age.js";
import { renderS3Remote, renderSftpRemote, writeManagedRcloneConfig } from "../offbox/rclone-conf.js";
import {
	type RecoveryKitRemote,
	recipientChallenge,
	renderRecoveryKit,
	writeRecoveryKit,
} from "../offbox/recovery-kit.js";
import { smokeTestRemoteIndex } from "../offbox/smoke.js";
import { previewSchedule } from "../schedule/scheduler.js";
import { runDoctor } from "./doctor.js";
import { runSync } from "./sync.js";

const WIZARD_CANCELLED = Symbol("wizard-cancelled");

type WizardCancelled = typeof WIZARD_CANCELLED;
type ConfiguredOffbox = Extract<OffboxConfig, { mode: "configured" }>;
type OffboxRemote = Extract<OffboxConfig, { mode: "configured" }>["remote"];

type OffboxSetupResult =
	| { kind: "skipped"; config: BlotterConfig }
	| { kind: "configured"; config: BlotterConfig; offbox: ConfiguredOffbox; identity: string };

interface RemoteSetup {
	remote: OffboxRemote;
	recovery: RecoveryKitRemote;
	managedConfig?: string;
}

function cancelWizard(): WizardCancelled {
	cancel("Setup cancelled.");
	return WIZARD_CANCELLED;
}

function promptResult<T>(value: T | symbol): T | WizardCancelled {
	return isCancel(value) ? cancelWizard() : value;
}

function required(value: string | undefined): string | undefined {
	return value?.trim() ? undefined : "Enter a value.";
}

function singleLine(value: string | undefined): string | undefined {
	return value?.includes("\n") || value?.includes("\r") ? "Use one line." : undefined;
}

async function askRequiredText(message: string): Promise<string | WizardCancelled> {
	const answer = promptResult(await text({ message, validate: required }));
	return answer === WIZARD_CANCELLED ? answer : answer.trim();
}

async function askOptionalText(message: string): Promise<string | WizardCancelled> {
	const answer = promptResult(await text({ message, defaultValue: "", validate: singleLine }));
	return answer === WIZARD_CANCELLED ? answer : answer.trim();
}

async function askSecret(message: string): Promise<string | WizardCancelled> {
	const answer = promptResult(await password({ message, validate: required }));
	return answer === WIZARD_CANCELLED ? answer : answer.trim();
}

function s3Destination(bucket: string, prefix: string): string {
	const cleanBucket = bucket.replace(/^\/+|\/+$/gu, "");
	const cleanPrefix = prefix.replace(/^\/+|\/+$/gu, "");
	return `blotter:${cleanPrefix === "" ? cleanBucket : `${cleanBucket}/${cleanPrefix}`}`;
}

async function askS3Remote(): Promise<RemoteSetup | WizardCancelled> {
	const endpoint = await askRequiredText("S3 endpoint");
	if (endpoint === WIZARD_CANCELLED) return endpoint;
	const accessKeyId = await askRequiredText("Access key ID");
	if (accessKeyId === WIZARD_CANCELLED) return accessKeyId;
	const secretAccessKey = await askSecret("Secret access key");
	if (secretAccessKey === WIZARD_CANCELLED) return secretAccessKey;
	const region = await askOptionalText("Region (optional)");
	if (region === WIZARD_CANCELLED) return region;
	const bucket = await askRequiredText("Bucket");
	if (bucket === WIZARD_CANCELLED) return bucket;
	const prefix = await askOptionalText("Prefix (optional)");
	if (prefix === WIZARD_CANCELLED) return prefix;
	const destination = s3Destination(bucket, prefix);

	return {
		remote: { destination, rcloneConfig: "managed" },
		recovery: {
			type: "s3-compatible",
			destination,
			endpoint,
			bucket,
			...(prefix === "" ? {} : { prefix }),
		},
		managedConfig: renderS3Remote({
			endpoint,
			accessKeyId,
			secretAccessKey,
			...(region === "" ? {} : { region }),
		}),
	};
}

async function askSftpRemote(): Promise<RemoteSetup | WizardCancelled> {
	const host = await askRequiredText("SFTP host");
	if (host === WIZARD_CANCELLED) return host;
	const user = await askRequiredText("SFTP user");
	if (user === WIZARD_CANCELLED) return user;
	const portAnswer = promptResult(
		await text({
			message: "Port (optional)",
			defaultValue: "",
			validate(value) {
				const answer = value?.trim() ?? "";
				if (answer === "") return undefined;
				if (!/^\d+$/u.test(answer)) return "Enter a port from 1 to 65535.";
				const port = Number.parseInt(answer, 10);
				return port >= 1 && port <= 65_535 ? undefined : "Enter a port from 1 to 65535.";
			},
		}),
	);
	if (portAnswer === WIZARD_CANCELLED) return portAnswer;
	const keyFile = await askOptionalText("SSH key file (optional)");
	if (keyFile === WIZARD_CANCELLED) return keyFile;
	const remotePath = await askRequiredText("Remote path");
	if (remotePath === WIZARD_CANCELLED) return remotePath;
	const port = portAnswer.trim() === "" ? undefined : Number.parseInt(portAnswer.trim(), 10);
	const destination = `blotter:${remotePath}`;

	return {
		remote: { destination, rcloneConfig: "managed" },
		recovery: {
			type: "sftp",
			destination,
			host,
			...(port === undefined ? {} : { port }),
			path: remotePath,
		},
		managedConfig: renderSftpRemote({
			host,
			user,
			...(port === undefined ? {} : { port }),
			...(keyFile === "" ? {} : { keyFile }),
		}),
	};
}

async function askCustomRemote(): Promise<RemoteSetup | WizardCancelled> {
	const destination = await askRequiredText("Rclone destination");
	if (destination === WIZARD_CANCELLED) return destination;
	const configMode = promptResult<"default" | "managed">(
		await select<"default" | "managed">({
			message: "Rclone config",
			options: [
				{ value: "default" as const, label: "Default rclone config" },
				{ value: "managed" as const, label: "Managed by blotter" },
			],
			initialValue: "default",
		}),
	);
	if (configMode === WIZARD_CANCELLED) return configMode;
	return {
		remote: { destination, rcloneConfig: configMode },
		recovery: { type: "rclone", destination },
	};
}

async function askRemote(): Promise<RemoteSetup | WizardCancelled> {
	const kind = promptResult<"s3" | "sftp" | "custom">(
		await select<"s3" | "sftp" | "custom">({
			message: "Remote kind",
			options: [
				{ value: "s3" as const, label: "S3-compatible" },
				{ value: "sftp" as const, label: "SFTP" },
				{ value: "custom" as const, label: "Any rclone destination" },
			],
			initialValue: "s3",
		}),
	);
	if (kind === WIZARD_CANCELLED) return kind;
	switch (kind) {
		case "s3":
			return await askS3Remote();
		case "sftp":
			return await askSftpRemote();
		case "custom":
			return await askCustomRemote();
	}
	throw new Error("Unknown remote kind");
}

async function saveRecoveryKit(kit: string, homePath: string): Promise<boolean | WizardCancelled> {
	const destination = promptResult<"save" | "print">(
		await select<"save" | "print">({
			message: "Recovery kit destination",
			options: [
				{ value: "save" as const, label: "Save to a file" },
				{ value: "print" as const, label: "Print to terminal" },
			],
			initialValue: "save",
		}),
	);
	if (destination === WIZARD_CANCELLED) return destination;
	if (destination === "print") {
		note(kit, "Recovery kit");
		return true;
	}

	const defaultPath = join(homePath, "blotter-recovery-kit.txt");
	const path = promptResult(
		await text({
			message: "Recovery kit path",
			initialValue: defaultPath,
			validate(value) {
				const path = value?.trim();
				if (!path) return "Enter a path.";
				return existsSync(path) ? "Path already exists. Choose another path." : undefined;
			},
		}),
	);
	if (path === WIZARD_CANCELLED) return path;
	await writeRecoveryKit(path.trim(), kit);
	log.success(`Saved recovery kit: ${path.trim()}`);
	return true;
}

async function verifyCustody(challenge: string): Promise<boolean | WizardCancelled> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const answer = promptResult(
			await text({
				message: "Enter the last 8 recipient characters from the recovery kit",
				validate: required,
			}),
		);
		if (answer === WIZARD_CANCELLED) return answer;
		if (answer.trim() === challenge) {
			return true;
		}
		if (attempt === 0) {
			log.warn("That did not match. One try left.");
		}
	}
	return false;
}

async function configureOffbox(config: BlotterConfig, homePath: string): Promise<OffboxSetupResult | WizardCancelled> {
	const home = resolveHome();
	const choice = promptResult<"skip" | "remote">(
		await select<"skip" | "remote">({
			message: "Off-box copies",
			options: [
				{ value: "skip" as const, label: "Skip for now" },
				{ value: "remote" as const, label: "Remote I own" },
			],
			initialValue: "skip",
		}),
	);
	if (choice === WIZARD_CANCELLED) return choice;
	if (choice === "skip") {
		return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
	}

	const remote = await askRemote();
	if (remote === WIZARD_CANCELLED) return remote;
	const identity = await generateIdentity();
	const recipient = await identityToRecipient(identity);
	const kit = renderRecoveryKit({
		identity,
		recipient,
		remote: remote.recovery,
		createdAt: new Date().toISOString(),
	});
	const saved = await saveRecoveryKit(kit, homePath);
	if (saved === WIZARD_CANCELLED) return saved;
	const custody = await verifyCustody(recipientChallenge(recipient));
	if (custody === WIZARD_CANCELLED) return custody;
	if (!custody) {
		log.warn("Custody was not verified. Off-box is skipped.");
		return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
	}
	log.success("Recovery kit verified. Future backups need no key prompt.");
	if (remote.managedConfig !== undefined) {
		await writeManagedRcloneConfig(home.rcloneConfPath, remote.managedConfig);
	}
	const offbox: ConfiguredOffbox = { mode: "configured", recipient, remote: remote.remote };
	return { kind: "configured", config: await writeInitConfig(home, config.archiveRoot, offbox), offbox, identity };
}

export async function runInitWizard(): Promise<number> {
	intro("blotter init");
	const home = resolveHome();
	const homePath = userHome();
	const detection = detectInitStores(homePath);
	if (detection.detected.length === 0) {
		log.info("Detected harnesses: none");
	} else {
		log.info(
			["Detected harnesses:", ...detection.detected.map((item) => `${item.displayName}: ${item.path}`)].join("\n"),
		);
	}
	if (detection.unsupported.length === 0) {
		log.info("Found, not yet supported: none");
	} else {
		log.info(
			["Found, not yet supported:", ...detection.unsupported.map((item) => `${item.displayName}: ${item.path}`)].join(
				"\n",
			),
		);
	}

	const existing = existsSync(home.configPath) ? loadConfig(home) : undefined;
	const defaultArchiveRoot = existing?.archiveRoot ?? home.defaultArchiveRoot;
	const archiveAnswer = promptResult(
		await text({
			message: "Archive root",
			initialValue: defaultArchiveRoot,
			validate(value) {
				const answer = value?.trim() ?? "";
				if (!isAbsolute(answer)) return "Use an absolute path.";
				if (existing !== undefined && answer !== existing.archiveRoot) {
					return `Archive root is already ${existing.archiveRoot}. Edit config.json to move it.`;
				}
				return undefined;
			},
		}),
	);
	if (archiveAnswer === WIZARD_CANCELLED) return 1;
	let config = await writeInitConfig(home, archiveAnswer.trim());

	const scheduleOptions = await createInitScheduleOptions(home, homePath);
	const schedule = previewSchedule(scheduleOptions);
	log.info(
		[
			"Schedule:",
			...schedule.artifactPaths.map((path) => `artifact: ${path}`),
			`node: ${scheduleOptions.nodePath}`,
			`entry: ${scheduleOptions.entryPath}`,
			"hourly at :03, plus at login/wake",
		].join("\n"),
	);
	const install = promptResult(await confirm({ message: "Install and activate this schedule?", initialValue: true }));
	if (install === WIZARD_CANCELLED) return 1;
	if (!install) {
		cancel("Setup stopped before schedule install.");
		return 1;
	}
	const installed = await installInitSchedule(scheduleOptions, true);
	for (const message of [...installed.schedule.notes, ...installed.activationNotes]) {
		log.info(message);
	}

	const configured = await configureOffbox(config, homePath);
	if (configured === WIZARD_CANCELLED) return 1;
	config = configured.config;

	let sweepCancelled = false;
	const sweep = spinner({
		onCancel() {
			sweepCancelled = true;
		},
	});
	let summary = "First sweep finished.";
	sweep.start("Running first sweep");
	let syncCode: number;
	while (true) {
		if (sweepCancelled) return 1;
		let busy = false;
		syncCode = await runSync([], {
			writeSummary: false,
			onSummary(value) {
				summary = value;
			},
			onBusy() {
				busy = true;
			},
		});
		if (!busy) break;
		if (sweepCancelled) return 1;
		sweep.message("Waiting for running sync");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (syncCode === 1) {
		sweep.error(summary);
	} else {
		sweep.stop(summary);
	}
	if (sweepCancelled) return 1;

	let remoteCode = 0;
	if (syncCode === 0 && configured.kind === "configured") {
		let remoteCancelled = false;
		const remoteCheck = spinner({
			onCancel() {
				remoteCancelled = true;
			},
		});
		remoteCheck.start("Checking remote index");
		try {
			await smokeTestRemoteIndex(config, configured.offbox, configured.identity);
			if (!remoteCancelled) remoteCheck.stop("Remote index checked.");
		} catch (error) {
			if (!remoteCancelled) {
				remoteCheck.error(`Remote index check failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			remoteCode = 1;
		}
		if (remoteCancelled) return 1;
	}

	const doctorCode = await runDoctor([]);
	const operationalFailure = syncCode === 1 || remoteCode === 1 || doctorCode === 1;
	outro(operationalFailure ? "Setup failed. Run `blotter status`." : "Done. Run `blotter status`.");
	return operationalFailure ? 1 : 0;
}
