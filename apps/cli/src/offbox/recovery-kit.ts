import { readFile } from "node:fs/promises";
import packageMetadata from "../../package.json" with { type: "json" };
import { errorMessage, PackbatError } from "../core/errors.js";
import { writePrivateFile } from "../core/private-file.js";

const RECOVERY_KIT_FORMAT = 2;

export type RecoveryKitRemote =
	| { type: "s3-compatible"; destination: string; endpoint: string; bucket: string; prefix?: string }
	| { type: "sftp"; destination: string; host: string; port?: number; path: string }
	| { type: "oauth"; provider: "google-drive" | "dropbox"; destination: string }
	| { type: "cloud"; destination: "Packbat Cloud"; machineRemoteId: string }
	| { type: "rclone"; destination: string };

export interface RecoveryKitInput {
	identity: string;
	recipient: string;
	remotes: [RecoveryKitRemote, ...RecoveryKitRemote[]];
	createdAt: string;
}

export interface CloudRecoveryLocator {
	machineRemoteId: string;
	recipient: string;
}

export interface RecoveryKitIdentity {
	identity: string;
	recipient: string;
}

export function parseRecoveryKitIdentity(contents: string): RecoveryKitIdentity {
	if (!contents.startsWith("Packbat recovery kit\n")) {
		throw new PackbatError("file is not a Packbat recovery kit");
	}
	const identity = /^Age identity\r?\n(AGE-SECRET-KEY-1[0-9A-Z]+)$/mu.exec(contents)?.[1];
	const recipient = /^Age recipient\r?\n(age1[0-9a-z]+)$/mu.exec(contents)?.[1];
	if (identity === undefined || recipient === undefined) {
		throw new PackbatError("recovery kit does not contain a valid age identity and recipient");
	}
	return { identity, recipient };
}

export async function readRecoveryKitIdentity(path: string): Promise<RecoveryKitIdentity> {
	try {
		return parseRecoveryKitIdentity(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof PackbatError) {
			throw error;
		}
		throw new PackbatError(`could not read recovery kit ${path}: ${errorMessage(error)}`);
	}
}

export function parseCloudRecoveryLocator(contents: string): CloudRecoveryLocator {
	if (!contents.startsWith("Packbat recovery kit\n")) {
		throw new PackbatError("file is not a Packbat recovery kit");
	}
	const recipient = /^Age recipient\r?\n(age1[0-9a-z]+)$/mu.exec(contents)?.[1];
	const machineRemoteIds = [
		...contents.matchAll(/^type: cloud\r?\ndestination: Packbat Cloud\r?\nmachine remote: ([A-Za-z0-9_-]{24})$/gmu),
	].map((match) => match[1]);
	const machineRemoteId = machineRemoteIds[0];
	if (recipient === undefined || machineRemoteId === undefined || machineRemoteIds.length !== 1) {
		throw new PackbatError("recovery kit does not contain one valid Packbat Cloud locator");
	}
	return { machineRemoteId, recipient };
}

export async function readCloudRecoveryLocator(path: string): Promise<CloudRecoveryLocator> {
	try {
		return parseCloudRecoveryLocator(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof PackbatError) {
			throw error;
		}
		throw new PackbatError(`could not read recovery kit ${path}: ${errorMessage(error)}`);
	}
}

function renderRemote(remote: RecoveryKitRemote): string {
	switch (remote.type) {
		case "s3-compatible":
			return [
				"type: s3-compatible",
				`endpoint: ${remote.endpoint}`,
				`bucket: ${remote.bucket}`,
				...(remote.prefix === undefined ? [] : [`prefix: ${remote.prefix}`]),
				`destination: ${remote.destination}`,
			].join("\n");
		case "sftp":
			return [
				"type: sftp",
				`host: ${remote.host}`,
				...(remote.port === undefined ? [] : [`port: ${remote.port}`]),
				`path: ${remote.path}`,
				`destination: ${remote.destination}`,
			].join("\n");
		case "oauth":
			return [
				"type: oauth",
				`provider: ${remote.provider}`,
				`destination: ${remote.destination}`,
				"authorization: re-authentication required on a new machine",
				"credentials: not included",
			].join("\n");
		case "rclone":
			return `type: rclone\ndestination: ${remote.destination}`;
		case "cloud":
			return `type: cloud\ndestination: Packbat Cloud\nmachine remote: ${remote.machineRemoteId}\ncredentials: not included`;
	}
}

function oauthFreshMachineSetup(remote: Extract<RecoveryKitRemote, { type: "oauth" }>): string {
	const provider = remote.provider === "google-drive" ? "Google Drive" : "Dropbox";
	return `Run packbat init, choose ${provider}, and authorize this destination in the browser.
Use destination: ${remote.destination}
The recovery kit intentionally contains no access token, refresh token, or OAuth client secret.`;
}

export function renderRecoveryKit(input: RecoveryKitInput): string {
	const remoteSections = input.remotes
		.map((remote, index) => `${input.remotes.length === 1 ? "Remote" : `Remote ${index + 1}`}\n${renderRemote(remote)}`)
		.join("\n\n");
	const firstRemote = input.remotes[0];
	const additionalSetup = input.remotes.length === 1 ? "" : "\nAdd the other remote destinations to config.json.\n";
	const freshMachineSetup =
		firstRemote.type === "oauth"
			? oauthFreshMachineSetup(firstRemote)
			: firstRemote.type === "cloud"
				? "Run packbat cloud link --restore-from <kit-file> on the new machine.\nThe recovery kit intentionally contains no Packbat Cloud credential."
				: `Configure rclone access to ${input.remotes.map((remote) => remote.destination).join(", ")}, then run:
packbat init --yes --offbox remote --offbox-remote ${firstRemote.destination} --age-recipient ${input.recipient} --rclone-config default`;
	const restoreCommands = input.remotes
		.map(
			(remote, index) =>
				`packbat restore --from-remote --identity <kit-file>${index === 0 ? "" : ` --remote ${remote.destination}`} <unit> --machine <source-machine>`,
		)
		.join("\n");
	return `Packbat recovery kit
Packbat version: ${packageMetadata.version}
format: ${RECOVERY_KIT_FORMAT}
created: ${input.createdAt}

Age identity
${input.identity}

Age recipient
${input.recipient}

${remoteSections}

Fresh-machine setup
${freshMachineSetup}
${additionalSetup}
Fresh-machine restore
${restoreCommands}

Raw age fallback
age -d -i <kit-file> -o <archive-file> <archive-file>.age

If every copy of this identity is lost, nobody can recover this archive.
`;
}

export async function writeRecoveryKit(path: string, contents: string): Promise<void> {
	await writePrivateFile(path, contents, { overwrite: false });
}
