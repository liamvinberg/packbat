import type { OffboxConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { discoverBackblazeStorage } from "./backblaze.js";
import { authorizeDropboxRemote, authorizeDropboxRemoteHeadless } from "./dropbox-oauth.js";
import { authorizeGoogleDriveInBrowser, beginGoogleDriveHeadlessAuthorization } from "./google-drive-oauth.js";
import { writeManagedRcloneConfig } from "./managed-rclone-config.js";
import { dropboxAppKey, googleDriveClient } from "./oauth-clients.js";
import { renderS3Remote, renderSftpRemote, type S3RemoteInput, type SftpRemoteInput } from "./rclone-conf.js";
import type { RecoveryKitRemote } from "./recovery-kit.js";
import { cloudflareR2Endpoint, guidedS3Destination } from "./s3-recipes.js";

type OffboxRemote = Extract<OffboxConfig, { mode: "configured" }>["remotes"][number];

export interface DestinationSetup {
	remote: OffboxRemote;
	recovery: RecoveryKitRemote;
	configure?: () => Promise<void>;
}

function managedS3Destination(options: {
	configPath: string;
	bucket: string;
	input: S3RemoteInput;
	recoveryEndpoint: string;
	prefix?: string;
}): DestinationSetup {
	const cleanBucket = options.bucket.replace(/^\/+|\/+$/gu, "");
	const defaultDestination = guidedS3Destination(cleanBucket);
	const cleanPrefix = options.prefix?.replace(/^\/+|\/+$/gu, "");
	const prefix = cleanPrefix === undefined || cleanPrefix === "" ? "packbat" : cleanPrefix;
	const destination = prefix === "packbat" ? defaultDestination : `packbat:${cleanBucket}/${prefix}`;
	return {
		remote: { type: "rclone", destination, rcloneConfig: "managed" },
		recovery: {
			type: "s3-compatible",
			destination,
			endpoint: options.recoveryEndpoint,
			bucket: cleanBucket,
			prefix,
		},
		configure: async () => {
			await writeManagedRcloneConfig(options.configPath, renderS3Remote(options.input));
		},
	};
}

export function createR2Destination(options: {
	configPath: string;
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
}): DestinationSetup {
	const endpoint = cloudflareR2Endpoint(options.accountId);
	return managedS3Destination({
		configPath: options.configPath,
		bucket: options.bucket,
		recoveryEndpoint: endpoint,
		input: {
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			endpoint,
			provider: "Cloudflare",
			region: "auto",
			acl: "private",
			noCheckBucket: true,
		},
	});
}

export interface BackblazeDestinationPreparation {
	buckets: readonly string[];
	select: (bucket: string) => DestinationSetup;
}

export async function prepareBackblazeDestination(options: {
	configPath: string;
	keyId: string;
	applicationKey: string;
}): Promise<BackblazeDestinationPreparation> {
	const storage = await discoverBackblazeStorage(options.keyId, options.applicationKey);
	return {
		buckets: storage.buckets,
		select(bucket) {
			if (!storage.buckets.includes(bucket)) throw new PackbatError("Backblaze bucket was not discovered");
			return managedS3Destination({
				configPath: options.configPath,
				bucket,
				recoveryEndpoint: storage.endpoint,
				input: {
					endpoint: storage.endpoint,
					accessKeyId: options.keyId,
					secretAccessKey: options.applicationKey,
					region: storage.region,
				},
			});
		},
	};
}

export function createAwsDestination(options: {
	configPath: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	bucket: string;
}): DestinationSetup {
	return managedS3Destination({
		configPath: options.configPath,
		bucket: options.bucket,
		recoveryEndpoint: `https://s3.${options.region}.amazonaws.com`,
		input: {
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			provider: "AWS",
			region: options.region,
		},
	});
}

export function createOtherS3Destination(options: {
	configPath: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
	bucket: string;
	prefix?: string;
}): DestinationSetup {
	return managedS3Destination({
		configPath: options.configPath,
		bucket: options.bucket,
		recoveryEndpoint: options.endpoint,
		input: {
			endpoint: options.endpoint,
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			...(options.region === undefined ? {} : { region: options.region }),
		},
		...(options.prefix === undefined ? {} : { prefix: options.prefix }),
	});
}

export function createSftpDestination(options: {
	configPath: string;
	remotePath: string;
	input: SftpRemoteInput;
}): DestinationSetup {
	const destination = `packbat:${options.remotePath}`;
	return {
		remote: { type: "rclone", destination, rcloneConfig: "managed" },
		recovery: {
			type: "sftp",
			destination,
			host: options.input.host,
			...(options.input.port === undefined ? {} : { port: options.input.port }),
			path: options.remotePath,
		},
		configure: async () => {
			await writeManagedRcloneConfig(options.configPath, renderSftpRemote(options.input));
		},
	};
}

export function createCustomRcloneDestination(destination: string): DestinationSetup {
	return {
		remote: { type: "rclone", destination, rcloneConfig: "default" },
		recovery: { type: "rclone", destination },
	};
}

function googleDriveDestination(configure: () => Promise<void>): DestinationSetup {
	const destination = "packbat:packbat";
	return {
		remote: { type: "rclone", destination, rcloneConfig: "managed" },
		recovery: { type: "oauth", provider: "google-drive", destination },
		configure,
	};
}

export function createGoogleDriveDestination(configPath: string): DestinationSetup {
	const client = googleDriveClient();
	return googleDriveDestination(
		async () => await authorizeGoogleDriveInBrowser({ ...client, configPath, remoteName: "packbat" }),
	);
}

export interface GoogleDriveHeadlessPreparation {
	browserCommand: string;
	complete: (token: string) => DestinationSetup;
}

export async function prepareGoogleDriveHeadlessDestination(
	configPath: string,
): Promise<GoogleDriveHeadlessPreparation> {
	const client = googleDriveClient();
	const continuation = await beginGoogleDriveHeadlessAuthorization({ ...client, configPath, remoteName: "packbat" });
	return {
		browserCommand: continuation.browserCommand,
		complete(token) {
			return googleDriveDestination(async () => await continuation.complete(token));
		},
	};
}

export type DropboxAuthorization =
	| { kind: "local"; onAuthorizationUrl: (url: string, opened: boolean) => void }
	| { kind: "headless"; onAuthorizationUrl: (url: string) => void; askCode: () => Promise<string> };

export function createDropboxDestination(configPath: string, authorization: DropboxAuthorization): DestinationSetup {
	const appKey = dropboxAppKey();
	const destination = "packbat:packbat";
	return {
		remote: { type: "rclone", destination, rcloneConfig: "managed" },
		recovery: { type: "oauth", provider: "dropbox", destination },
		configure: async () => {
			if (authorization.kind === "headless") {
				await authorizeDropboxRemoteHeadless({
					appKey,
					configPath,
					remoteName: "packbat",
					onAuthorizationUrl: authorization.onAuthorizationUrl,
					askCode: authorization.askCode,
				});
			} else {
				await authorizeDropboxRemote({
					appKey,
					configPath,
					remoteName: "packbat",
					onAuthorizationUrl: authorization.onAuthorizationUrl,
				});
			}
		},
	};
}
