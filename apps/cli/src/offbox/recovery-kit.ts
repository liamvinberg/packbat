import packageMetadata from "../../package.json" with { type: "json" };
import { writePrivateFile } from "../core/private-file.js";

export type RecoveryKitRemote =
	| { type: "s3-compatible"; destination: string; endpoint: string; bucket: string; prefix?: string }
	| { type: "sftp"; destination: string; host: string; port?: number; path: string }
	| { type: "rclone"; destination: string };

export interface RecoveryKitInput {
	identity: string;
	recipient: string;
	remote: RecoveryKitRemote;
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
		case "rclone":
			return `type: rclone\ndestination: ${remote.destination}`;
	}
}

export function renderRecoveryKit(input: RecoveryKitInput): string {
	return `blotter recovery kit
blotter version: ${packageMetadata.version}
format: 1
created: ${input.createdAt}

Age identity
${input.identity}

Age recipient
${input.recipient}

Remote
${renderRemote(input.remote)}

Fresh-machine setup
Configure rclone access to ${input.remote.destination}, then run:
blotter init --yes --offbox remote --offbox-remote ${input.remote.destination} --age-recipient ${input.recipient} --rclone-config default

Fresh-machine restore
blotter restore --from-remote --identity <kit-file> <unit> --machine <source-machine>

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
