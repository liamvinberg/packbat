import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, spinner, text } from "@clack/prompts";
import { createCloudMachine } from "../cloud/client.js";
import { type CloudLinkEvents, ensureCloudUploadReady } from "../cloud/link.js";
import { generateIdentity, identityToRecipient, parseIdentityFile } from "../offbox/age.js";
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
import {
	parseRecoveryKitIdentity,
	type RecoveryKitIdentity,
	readRecoveryKitIdentity,
	renderRecoveryKit,
	writeRecoveryKit,
} from "../offbox/recovery-kit.js";
import { smokeTestRemoteIndex } from "../offbox/smoke.js";
import { previewSchedule } from "../schedule/scheduler.js";
import { loadConfig, type OffboxConfig, type PackbatConfig, remoteDestination } from "./config.js";
import { errorMessage, PackbatError } from "./errors.js";
import { commandOnPath } from "./exec.js";
import { expandTilde } from "./fs.js";
import { resolveHome } from "./home.js";
import { readLockHolder } from "./lock.js";
import { writePrivateFile } from "./private-file.js";
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

type DestinationChoice = "google-drive" | "dropbox" | "s3" | "server" | "skip" | "cloud";

const cloudLinkEvents: CloudLinkEvents = {
	onDeviceCode(code, verificationUri, opened) {
		note(`${code}${opened ? "" : `\n${verificationUri}`}`, "GitHub device authorization");
		log.info("Waiting for GitHub authorization.");
	},
	onCheckout(url, opened) {
		if (!opened) note(url, "Stripe Checkout");
	},
	onWaitingForPayment() {
		log.info("Waiting for Stripe Checkout.");
	},
};

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
	const keyFileAnswer = await askOptionalText("SSH key file (optional)");
	if (keyFileAnswer === WIZARD_CANCELLED) return keyFileAnswer;
	const keyFile = expandTilde(keyFileAnswer);
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

async function askCloudInterval(): Promise<"month" | "year" | WizardCancelled> {
	return promptResult<"month" | "year">(
		await select<"month" | "year">({
			message: "Packbat Cloud billing",
			options: [
				{ value: "month", label: "Monthly · $5" },
				{ value: "year", label: "Annual · $50" },
			],
			initialValue: "month",
		}),
	);
}

async function askRemote(
	choice: Exclude<DestinationChoice, "skip" | "cloud">,
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

type KitDestination = { kind: "print" } | { kind: "save"; path: string };

async function askKitDestination(homePath: string): Promise<KitDestination | WizardCancelled> {
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
	if (destination === "print") return { kind: "print" };

	const defaultPath = join(homePath, "packbat-recovery-kit.txt");
	const answer = promptResult(
		await text({
			message: "Recovery kit path",
			initialValue: defaultPath,
			validate(value) {
				const path = expandTilde(value?.trim() ?? "");
				if (!path) return "Enter a path.";
				return existsSync(path) ? "Path already exists. Choose another path." : undefined;
			},
		}),
	);
	if (answer === WIZARD_CANCELLED) return answer;
	return { kind: "save", path: expandTilde(answer.trim()) };
}

async function deliverRecoveryKit(
	kit: string,
	minted: RecoveryKitIdentity,
	destination: KitDestination,
): Promise<void> {
	if (destination.kind === "print") {
		note(kit, "Recovery kit");
		log.warn(
			"This terminal is the only copy. Put it somewhere safe off this machine before closing, a password manager works.",
		);
		return;
	}
	await writeRecoveryKit(destination.path, kit);
	const written = await readRecoveryKitIdentity(destination.path);
	if (written.identity !== minted.identity || written.recipient !== minted.recipient) {
		throw new PackbatError(`recovery kit at ${destination.path} did not read back correctly`); // DRAFT copy
	}
	log.success(`Saved and read back the recovery kit: ${destination.path}`); // DRAFT copy
	log.warn("Keep a copy off this machine, a password manager works.");
}

async function askPastedIdentity(): Promise<RecoveryKitIdentity | WizardCancelled | null> {
	const answer = promptResult(
		await password({
			message: "AGE-SECRET-KEY line", // DRAFT copy
			validate(value) {
				return required(value) ?? singleLine(value);
			},
		}),
	);
	if (answer === WIZARD_CANCELLED) return answer;
	try {
		const identity = parseIdentityFile(answer.trim().toUpperCase());
		return { identity, recipient: await identityToRecipient(identity) };
	} catch {
		log.warn("That is not an AGE-SECRET-KEY line from a recovery kit."); // DRAFT copy
		return null;
	}
}

async function askRecoveryKitFile(): Promise<RecoveryKitIdentity | WizardCancelled | null> {
	const answer = promptResult(
		await text({
			message: "Recovery kit path",
			validate(value) {
				const path = expandTilde(value?.trim() ?? "");
				if (!path) return "Enter a path.";
				if (!existsSync(path)) return `No recovery kit at ${path}.`; // DRAFT copy
				try {
					parseRecoveryKitIdentity(readFileSync(path, "utf8"));
					return undefined;
				} catch (error) {
					return errorMessage(error);
				}
			},
		}),
	);
	if (answer === WIZARD_CANCELLED) return answer;
	let imported: RecoveryKitIdentity;
	try {
		imported = await readRecoveryKitIdentity(expandTilde(answer.trim()));
	} catch (error) {
		log.warn(errorMessage(error));
		return null;
	}
	let recipient: string;
	try {
		recipient = await identityToRecipient(imported.identity);
	} catch (error) {
		log.warn(`could not parse age identity from recovery kit: ${errorMessage(error)}`); // DRAFT copy
		return null;
	}
	if (recipient !== imported.recipient) {
		log.warn("recovery kit identity does not match its age recipient"); // DRAFT copy
		return null;
	}
	return { identity: imported.identity, recipient };
}

async function importRecoveryIdentity(configuredRecipient?: string): Promise<RecoveryKitIdentity | WizardCancelled> {
	const source = promptResult<"paste" | "file">(
		await select<"paste" | "file">({
			message: "Recovery kit source", // DRAFT copy
			options: [
				{ value: "paste" as const, label: "Paste the AGE-SECRET-KEY line" }, // DRAFT copy
				{ value: "file" as const, label: "Read a recovery kit file" }, // DRAFT copy
			],
			initialValue: "paste",
		}),
	);
	if (source === WIZARD_CANCELLED) return source;
	while (true) {
		const imported = source === "paste" ? await askPastedIdentity() : await askRecoveryKitFile();
		if (imported === WIZARD_CANCELLED) return imported;
		if (imported === null) continue;
		if (configuredRecipient !== undefined && imported.recipient !== configuredRecipient) {
			log.warn("recovery kit identity does not match the configured age recipient"); // DRAFT copy
			continue;
		}
		return imported;
	}
}

async function residentIdentityMatching(identityPath: string, recipient: string): Promise<string | null> {
	try {
		const identity = parseIdentityFile(await readFile(identityPath, "utf8"));
		return (await identityToRecipient(identity)) === recipient ? identity : null;
	} catch {
		return null;
	}
}

async function configureOffbox(config: PackbatConfig, homePath: string): Promise<OffboxSetupResult | WizardCancelled> {
	const home = resolveHome();
	if (config.offbox.mode === "configured") {
		const resident = await residentIdentityMatching(home.identityPath, config.offbox.recipient);
		if (resident !== null) {
			return { kind: "configured", config, offbox: config.offbox, identity: resident };
		}
		const imported = await importRecoveryIdentity(config.offbox.recipient);
		if (imported === WIZARD_CANCELLED) return imported;
		await writePrivateFile(home.identityPath, `${imported.identity}\n`);
		return { kind: "configured", config, offbox: config.offbox, identity: imported.identity };
	}
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
				{
					value: "cloud" as const,
					label: "Packbat Cloud",
					hint: "$5/month or $50/year. 100 GB. End-to-end encrypted. We can never read your archive.", // DRAFT copy
				},
			],
			initialValue: "skip",
		}),
	);
	if (choice === WIZARD_CANCELLED) return choice;
	if (choice === "skip") {
		return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
	}
	let createRemote: () => Promise<DestinationSetup>;
	if (choice === "cloud") {
		const interval = await askCloudInterval();
		if (interval === WIZARD_CANCELLED) return interval;
		await ensureCloudUploadReady(home, interval, cloudLinkEvents);
		createRemote = async (): Promise<DestinationSetup> => {
			const machineRemoteId = await createCloudMachine(home);
			return {
				remote: { type: "cloud", machineRemoteId },
				recovery: { type: "cloud", destination: "Packbat Cloud", machineRemoteId },
			};
		};
	} else {
		const rclone = await ensureRclone();
		if (rclone === WIZARD_CANCELLED) return rclone;
		if (!rclone) {
			return { kind: "skipped", config: await writeInitConfig(home, config.archiveRoot, skippedOffboxConfig()) };
		}
		const selected = await askRemote(choice, home.rcloneConfPath);
		if (selected === WIZARD_CANCELLED) return selected;
		createRemote = async () => selected;
	}
	const identityChoice = promptResult<"mint" | "join">(
		await select<"mint" | "join">({
			message: "Encryption key", // DRAFT copy
			options: [
				{ value: "mint", label: "This is my first Packbat machine" }, // DRAFT copy
				{ value: "join", label: "I have a recovery kit" }, // DRAFT copy
			],
			initialValue: "mint",
		}),
	);
	if (identityChoice === WIZARD_CANCELLED) return identityChoice;
	let identity: string;
	let recipient: string;
	let remote: DestinationSetup;
	if (identityChoice === "join") {
		const imported = await importRecoveryIdentity();
		if (imported === WIZARD_CANCELLED) return imported;
		({ identity, recipient } = imported);
		remote = await createRemote();
	} else {
		identity = await generateIdentity();
		recipient = await identityToRecipient(identity);
		const destination = await askKitDestination(homePath);
		if (destination === WIZARD_CANCELLED) return destination;
		remote = await createRemote();
		const kit = renderRecoveryKit({
			identity,
			recipient,
			remotes: [remote.recovery],
			createdAt: new Date().toISOString(),
		});
		await deliverRecoveryKit(kit, { identity, recipient }, destination);
		log.warn("The recovery kit is the backup for the key kept on this machine."); // DRAFT copy
	}
	if (remote.configure !== undefined) {
		await remote.configure();
	}
	await writePrivateFile(home.identityPath, `${identity}\n`);
	const offbox: ConfiguredOffbox = { mode: "configured", recipient, remotes: [remote.remote] };
	return { kind: "configured", config: await writeInitConfig(home, config.archiveRoot, offbox), offbox, identity };
}

async function busySyncMessage(statePath: string): Promise<string> {
	const holder = await readLockHolder(statePath, "sync");
	const started = holder === null ? Number.NaN : new Date(holder.startedAt).getTime();
	if (Number.isNaN(started)) return "Waiting for the running sync";
	const time = new Date(started).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `Waiting for the sync that started at ${time} to finish`; // DRAFT copy
}

export interface InitWizardActions {
	doctor: () => Promise<number>;
	sync: (output: {
		writeSummary: false;
		onSummary: (summary: string) => void;
		onBusy: () => void;
		onOffboxProgress: (destination: string, done: number, total: number) => void;
	}) => Promise<number>;
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
				const answer = expandTilde(value?.trim() ?? "");
				if (!isAbsolute(answer)) return "Use an absolute path.";
				if (existing !== undefined && answer !== existing.archiveRoot) {
					return `Archive root is already ${existing.archiveRoot}. Edit config.json to move it.`;
				}
				return undefined;
			},
		}),
	);
	if (archiveAnswer === WIZARD_CANCELLED) return 1;
	let config = await writeInitConfig(home, expandTilde(archiveAnswer.trim()));

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

	if (configured.kind === "configured") {
		log.info("The first sync uploads the whole archive off-box. A large archive can take a while."); // DRAFT copy
	}
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
			onOffboxProgress(destination, done, total) {
				if (done === 0 || done === total || done % 25 === 0) {
					sweep.message(`Uploading to ${destination}: ${done} of ${total}`); // DRAFT copy
				}
			},
		});
		if (!busy) break;
		if (sweepCancelled) return 1;
		sweep.message(await busySyncMessage(home.statePath));
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
				remoteErrors.push(`${remoteDestination(remote)}: ${error instanceof Error ? error.message : String(error)}`);
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
