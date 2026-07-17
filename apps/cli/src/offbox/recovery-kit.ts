import packageMetadata from "../../package.json" with { type: "json" };
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
				? `Run packbat cloud link on the new machine, then add machine remote ${firstRemote.machineRemoteId} to config.json for restore.\nThe recovery kit intentionally contains no Packbat Cloud credential.`
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

export function recipientChallenge(recipient: string): string {
	return recipient.slice(-8);
}

export async function writeRecoveryKit(path: string, contents: string): Promise<void> {
	await writePrivateFile(path, contents, { overwrite: false });
}
