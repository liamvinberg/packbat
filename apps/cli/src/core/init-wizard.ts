import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, spinner, text } from "@clack/prompts";
import { generateIdentity, identityToRecipient } from "../offbox/age.js";
import {
	createAwsDestination,
	createCustomRcloneDestination,
	createDropboxDestination,
	createGoogleDriveDestination,
	createOtherS3Destination,
	createR2Destination,
	createSftpDestination,
	type DestinationSetup,
	prepareBackblazeDestination,
	prepareGoogleDriveHeadlessDestination,
} from "../offbox/destination-setup.js";
import { discoverRclone } from "../offbox/rclone.js";
import { pickRcloneInstall } from "../offbox/rclone-install.js";
import { recipientChallenge, renderRecoveryKit, writeRecoveryKit } from "../offbox/recovery-kit.js";
import { smokeTestRemoteIndex } from "../offbox/smoke.js";
import { previewSchedule } from "../schedule/scheduler.js";
import { loadConfig, type OffboxConfig, type PackbatConfig } from "./config.js";
import { commandOnPath } from "./exec.js";
import { resolveHome } from "./home.js";
import {
	createInitScheduleOptions,
	detectInitStores,
	installInitSchedule,
	skippedOffboxConfig,
	userHome,
	writeInitConfig,
} from "./setup.js";

const WIZARD_CANCELLED = Symbol("wizard-cancelled");

const RCLONE_INSTALL_COPY = {
	brewConfirm: "Install rclone with Homebrew? (runs: brew install rclone)",
	manualNoteTitle: "Install rclone",
	manualConfirm: "Is rclone installed now?",
	skipped: "Off-box is skipped because rclone is not installed.",
} as const;

type WizardCancelled = typeof WIZARD_CANCELLED;
type ConfiguredOffbox = Extract<OffboxConfig, { mode: "configured" }>;
type OffboxSetupResult =
	| { kind: "skipped"; config: PackbatConfig }
	| { kind: "configured"; config: PackbatConfig; offbox: ConfiguredOffbox; identity: string };

type DestinationChoice = "google-drive" | "dropbox" | "s3" | "server" | "skip";

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
	const answer = promptResult(
		await text({
			message,
			validate(value) {
				return required(value) ?? singleLine(value);
			},
		}),
	);
	return answer === WIZARD_CANCELLED ? answer : answer.trim();
}

async function askOptionalText(message: string): Promise<string | WizardCancelled> {
	const answer = promptResult(await text({ message, defaultValue: "", validate: singleLine }));
	return answer === WIZARD_CANCELLED ? answer : answer.trim();
}

async function askSecret(message: string): Promise<string | WizardCancelled> {
	const answer = promptResult(
		await password({
			message,
			validate(value) {
				return required(value) ?? singleLine(value);
			},
		}),
	);
	return answer === WIZARD_CANCELLED ? answer : answer.trim();
}

async function runStreaming(command: readonly string[]): Promise<void> {
	const executable = command[0];
	if (executable === undefined) return;
	await new Promise<void>((resolve) => {
		const child = spawn(executable, command.slice(1), { env: process.env, stdio: "inherit" });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
	});
}

async function ensureRclone(): Promise<boolean | WizardCancelled> {
	try {
		await discoverRclone();
		return true;
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("rclone was not found")) {
			throw error;
		}
	}

	const hasBrew = commandOnPath("brew") !== null;
	const install = pickRcloneInstall(process.platform, (command) => command === "brew" && hasBrew);
	if (install.kind === "brew") {
		const accepted = promptResult(await confirm({ message: RCLONE_INSTALL_COPY.brewConfirm, initialValue: true }));
		if (accepted === WIZARD_CANCELLED) return accepted;
		if (!accepted) {
			log.info(RCLONE_INSTALL_COPY.skipped);
			return false;
		}
		await runStreaming(install.command);
	} else {
		note(install.command, RCLONE_INSTALL_COPY.manualNoteTitle);
		const ready = promptResult(await confirm({ message: RCLONE_INSTALL_COPY.manualConfirm, initialValue: true }));
		if (ready === WIZARD_CANCELLED) return ready;
		if (!ready) {
			log.info(RCLONE_INSTALL_COPY.skipped);
			return false;
		}
	}

	try {
		await discoverRclone();
		return true;
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("rclone was not found")) {
			throw error;
		}
		log.info(RCLONE_INSTALL_COPY.skipped);
		return false;
	}
}

async function askOtherS3Remote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
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
	return createOtherS3Destination({
		configPath,
		endpoint,
		accessKeyId,
		secretAccessKey,
		...(region === "" ? {} : { region }),
		bucket,
		...(prefix === "" ? {} : { prefix }),
	});
}

async function askR2Remote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
	note(
		[
			"1. Create a private R2 bucket.",
			"2. Create an Object Read and Write token scoped to that bucket.",
			"3. Copy the Account ID, Access Key ID, and Secret Access Key before leaving the page.",
		].join("\n"),
		"Cloudflare R2",
	);
	const accountId = await askRequiredText("Cloudflare account ID");
	if (accountId === WIZARD_CANCELLED) return accountId;
	const accessKeyId = await askRequiredText("Access Key ID");
	if (accessKeyId === WIZARD_CANCELLED) return accessKeyId;
	const secretAccessKey = await askSecret("Secret Access Key");
	if (secretAccessKey === WIZARD_CANCELLED) return secretAccessKey;
	const bucket = await askRequiredText("Bucket");
	if (bucket === WIZARD_CANCELLED) return bucket;
	return createR2Destination({ configPath, accountId, accessKeyId, secretAccessKey, bucket });
}

async function askBackblazeRemote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
	note(
		[
			"1. Create a private B2 bucket.",
			"2. Create a Read and Write application key restricted to that bucket.",
			"3. Copy the keyID and applicationKey before leaving the page.",
		].join("\n"),
		"Backblaze B2",
	);
	const keyId = await askRequiredText("keyID");
	if (keyId === WIZARD_CANCELLED) return keyId;
	const applicationKey = await askSecret("applicationKey");
	if (applicationKey === WIZARD_CANCELLED) return applicationKey;
	const preparation = await prepareBackblazeDestination({ configPath, keyId, applicationKey });
	if (preparation.buckets.length === 1) {
		return preparation.select(preparation.buckets[0]!);
	}
	const bucket = promptResult(
		await select({
			message: "Bucket",
			options: preparation.buckets.map((name) => ({ value: name, label: name })),
		}),
	);
	if (bucket === WIZARD_CANCELLED) return bucket;
	return preparation.select(bucket);
}

async function askAwsRemote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
	note(
		[
			"1. Create a private S3 bucket.",
			"2. Create an IAM policy limited to that bucket.",
			"3. Create an access key for the policy user.",
		].join("\n"),
		"AWS S3",
	);
	const accessKeyId = await askRequiredText("Access key ID");
	if (accessKeyId === WIZARD_CANCELLED) return accessKeyId;
	const secretAccessKey = await askSecret("Secret access key");
	if (secretAccessKey === WIZARD_CANCELLED) return secretAccessKey;
	const region = await askRequiredText("Region");
	if (region === WIZARD_CANCELLED) return region;
	const bucket = await askRequiredText("Bucket");
	if (bucket === WIZARD_CANCELLED) return bucket;
	return createAwsDestination({ configPath, accessKeyId, secretAccessKey, region, bucket });
}

async function askS3Remote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
	const provider = promptResult<"r2" | "b2" | "aws" | "other">(
		await select<"r2" | "b2" | "aws" | "other">({
			message: "S3 provider",
			options: [
				{ value: "r2" as const, label: "Cloudflare R2" },
				{ value: "b2" as const, label: "Backblaze B2" },
				{ value: "aws" as const, label: "AWS" },
				{ value: "other" as const, label: "Other S3-compatible provider" },
			],
			initialValue: "r2",
		}),
	);
	if (provider === WIZARD_CANCELLED) return provider;
	switch (provider) {
		case "r2":
			return await askR2Remote(configPath);
		case "b2":
			return await askBackblazeRemote(configPath);
		case "aws":
			return await askAwsRemote(configPath);
		case "other":
			return await askOtherS3Remote(configPath);
	}
}

async function askSftpRemote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
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
	return createSftpDestination({
		configPath,
		remotePath,
		input: {
			host,
			user,
			...(port === undefined ? {} : { port }),
			...(keyFile === "" ? {} : { keyFile }),
		},
	});
}

async function askCustomRemote(): Promise<DestinationSetup | WizardCancelled> {
	const destination = await askRequiredText("Rclone destination");
	if (destination === WIZARD_CANCELLED) return destination;
	const configMode = promptResult<"default" | "managed">(
		await select<"default" | "managed">({
			message: "Rclone config",
			options: [
				{ value: "default" as const, label: "Default rclone config" },
				{
					value: "managed" as const,
					label: "Managed by Packbat",
					hint: "Choose a guided destination for this option",
					disabled: true,
				},
			],
			initialValue: "default",
		}),
	);
	if (configMode === WIZARD_CANCELLED) return configMode;
	return createCustomRcloneDestination(destination);
}

async function askServerRemote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
	const kind = promptResult<"sftp" | "custom">(
		await select<"sftp" | "custom">({
			message: "Server connection",
			options: [
				{ value: "sftp" as const, label: "SFTP" },
				{ value: "custom" as const, label: "Any rclone destination" },
			],
			initialValue: "sftp",
		}),
	);
	if (kind === WIZARD_CANCELLED) return kind;
	switch (kind) {
		case "sftp":
			return await askSftpRemote(configPath);
		case "custom":
			return await askCustomRemote();
	}
}

async function askGoogleDriveRemote(configPath: string): Promise<DestinationSetup | WizardCancelled> {
	const authorization = promptResult<"local" | "headless">(
		await select<"local" | "headless">({
			message: "Google Drive authorization",
			options: [
				{ value: "local" as const, label: "Open a browser on this machine" },
				{ value: "headless" as const, label: "Use a browser on another machine" },
			],
			initialValue: "local",
		}),
	);
	if (authorization === WIZARD_CANCELLED) return authorization;
	if (authorization === "local") return createGoogleDriveDestination(configPath);
	const preparation = await prepareGoogleDriveHeadlessDestination(configPath);
	note(preparation.browserCommand, "Run on the browser machine");
	const token = await askSecret("Paste the rclone authorize result");
	if (token === WIZARD_CANCELLED) return token;
	return preparation.complete(token);
}

async function askRemote(
	choice: Exclude<DestinationChoice, "skip">,
	configPath: string,
): Promise<DestinationSetup | WizardCancelled> {
	switch (choice) {
		case "google-drive":
			return await askGoogleDriveRemote(configPath);
		case "dropbox":
			return createDropboxDestination(configPath);
		case "s3":
			return await askS3Remote(configPath);
		case "server":
			return await askServerRemote(configPath);
	}
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
		log.warn(
			"This terminal is the only copy. Put it somewhere safe off this machine before closing, a password manager works.",
		);
		return true;
	}

	const defaultPath = join(homePath, "packbat-recovery-kit.txt");
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
	log.warn("Keep a copy off this machine, a password manager works.");
	return true;
}

async function verifyCustody(challenge: string): Promise<boolean | WizardCancelled> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const answer = promptResult(
			await text({
				message: "Enter the last 8 characters of the recipient from the recovery kit",
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

async function configureOffbox(config: PackbatConfig, homePath: string): Promise<OffboxSetupResult | WizardCancelled> {
	const home = resolveHome();
	log.info("Right now your archive lives only on this machine. An encrypted copy on a remote you own survives it.");
	const choice = promptResult<DestinationChoice>(
		await select<DestinationChoice>({
			message: "Off-box destination",
			options: [
				{ value: "google-drive" as const, label: "Google Drive" },
				{ value: "dropbox" as const, label: "Dropbox" },
				{ value: "s3" as const, label: "An S3 bucket" },
				{ value: "server" as const, label: "My own server" },
				{ value: "skip" as const, label: "Skip for now" },
			],
			initialValue: "skip",
		}),
	);
	if (choice === WIZARD_CANCELLED) return choice;
	if (choice === "skip") {
		return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
	}
	const rclone = await ensureRclone();
	if (rclone === WIZARD_CANCELLED) return rclone;
	if (!rclone) {
		return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
	}

	const remote = await askRemote(choice, home.rcloneConfPath);
	if (remote === WIZARD_CANCELLED) return remote;
	const identity = await generateIdentity();
	const recipient = await identityToRecipient(identity);
	const kit = renderRecoveryKit({
		identity,
		recipient,
		remotes: [remote.recovery],
		createdAt: new Date().toISOString(),
	});
	const saved = await saveRecoveryKit(kit, homePath);
	if (saved === WIZARD_CANCELLED) return saved;
	log.warn("The recovery kit holds the only key. Off-box copies cannot be decrypted without it.");
	const custody = await verifyCustody(recipientChallenge(recipient));
	if (custody === WIZARD_CANCELLED) return custody;
	if (!custody) {
		log.warn("The recovery kit was not verified. Off-box is skipped.");
		return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
	}
	log.success("Recovery kit verified. The key is only needed to restore from the remote.");
	if (remote.configure !== undefined) {
		await remote.configure();
	}
	const offbox: ConfiguredOffbox = { mode: "configured", recipient, remotes: [remote.remote] };
	return { kind: "configured", config: await writeInitConfig(home, config.archiveRoot, offbox), offbox, identity };
}

export interface InitWizardActions {
	doctor: () => Promise<number>;
	sync: (output: { writeSummary: false; onSummary: (summary: string) => void; onBusy: () => void }) => Promise<number>;
}

export async function runInitWizardWorkflow(
	options: { activateSchedule: boolean },
	actions: InitWizardActions,
): Promise<number> {
	intro("packbat init");
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
		log.info("Found but not yet supported: none");
	} else {
		log.info(
			[
				"Found but not yet supported:",
				...detection.unsupported.map((item) => `${item.displayName}: ${item.path}`),
			].join("\n"),
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
	const install = promptResult(
		await confirm({
			message: options.activateSchedule ? "Install and activate this schedule?" : "Install this schedule?",
			initialValue: true,
		}),
	);
	if (install === WIZARD_CANCELLED) return 1;
	if (!install) {
		cancel("Setup stopped before schedule install.");
		return 1;
	}
	const installed = await installInitSchedule(scheduleOptions, options.activateSchedule);
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
	let summary = "First sync finished.";
	sweep.start("Running first sync");
	let syncCode: number;
	while (true) {
		if (sweepCancelled) return 1;
		let busy = false;
		syncCode = await actions.sync({
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
		sweep.message("Waiting for the running sync");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (syncCode === 1) {
		sweep.error(summary);
	} else {
		sweep.stop(summary);
	}
	if (sweepCancelled) return 1;

	let remoteCode = 0;
	if (configured.kind === "configured") {
		let remoteCancelled = false;
		const remoteCheck = spinner({
			onCancel() {
				remoteCancelled = true;
			},
		});
		remoteCheck.start("Checking remote index");
		const remoteErrors: string[] = [];
		for (const remote of configured.offbox.remotes) {
			try {
				await smokeTestRemoteIndex(config, remote, configured.identity);
			} catch (error) {
				remoteErrors.push(`${remote.destination}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (remoteErrors.length === 0) {
			if (!remoteCancelled) remoteCheck.stop("Remote index checked.");
		} else {
			if (!remoteCancelled) {
				remoteCheck.error(`Remote index check failed: ${remoteErrors.join("; ")}`);
			}
			remoteCode = 1;
		}
		if (remoteCancelled) return 1;
	}

	const doctorCode = await actions.doctor();
	const operationalFailure = syncCode === 1 || remoteCode === 1 || doctorCode === 1;
	outro(operationalFailure ? "Setup failed. Run `packbat doctor`." : "Done. Run `packbat status`.");
	return operationalFailure ? 1 : 0;
}
