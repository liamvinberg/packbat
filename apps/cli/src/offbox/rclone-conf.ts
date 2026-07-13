import { writePrivateFile } from "../core/private-file.js";

export interface S3RemoteInput {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
}

export interface SftpRemoteInput {
	host: string;
	user: string;
	port?: number;
	keyFile?: string;
}

function renderRemote(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

export function renderS3Remote(input: S3RemoteInput): string {
	return renderRemote([
		"[blotter]",
		"type = s3",
		"provider = Other",
		`access_key_id = ${input.accessKeyId}`,
		`secret_access_key = ${input.secretAccessKey}`,
		`endpoint = ${input.endpoint}`,
		...(input.region === undefined ? [] : [`region = ${input.region}`]),
	]);
}

export function renderSftpRemote(input: SftpRemoteInput): string {
	return renderRemote([
		"[blotter]",
		"type = sftp",
		`host = ${input.host}`,
		`user = ${input.user}`,
		...(input.port === undefined ? [] : [`port = ${input.port}`]),
		...(input.keyFile === undefined ? [] : [`key_file = ${input.keyFile}`]),
	]);
}

export async function writeManagedRcloneConfig(path: string, contents: string): Promise<void> {
	await writePrivateFile(path, contents);
}
