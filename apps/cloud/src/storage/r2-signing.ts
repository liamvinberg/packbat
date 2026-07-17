import { AwsClient } from "aws4fetch";

export const OBJECT_CONTENT_TYPE = "application/octet-stream";
export const OBJECT_CACHE_CONTROL = "no-store";

const PRESIGNED_URL_LIFETIME_SECONDS = 5 * 60;

export interface R2SigningConfig {
	accountId: string;
	accessKeyId: string;
	bucketName: string;
	secretAccessKey: string;
}

export interface UploadConditions {
	checksumSha256: string;
	contentLength: number;
	expectedEtag?: string | null;
}

export interface SignedUpload {
	expiresAt: number;
	headers: Record<string, string>;
	url: string;
}

function client(config: R2SigningConfig): AwsClient {
	return new AwsClient({
		accessKeyId: config.accessKeyId,
		region: "auto",
		secretAccessKey: config.secretAccessKey,
		service: "s3",
	});
}

function encodeObjectPath(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

function objectUrl(config: R2SigningConfig, key: string, expiresIn: number): URL {
	const url = new URL(
		`https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${encodeObjectPath(key)}`,
	);
	url.searchParams.set("X-Amz-Expires", String(expiresIn));
	return url;
}

export async function signUpload(
	config: R2SigningConfig,
	key: string,
	conditions: UploadConditions,
	now: number,
	expiresAt = now + PRESIGNED_URL_LIFETIME_SECONDS,
): Promise<SignedUpload> {
	const expiresIn = Math.max(1, expiresAt - now);
	const headers: Record<string, string> = {
		"Cache-Control": OBJECT_CACHE_CONTROL,
		"Content-Length": String(conditions.contentLength),
		"Content-Type": OBJECT_CONTENT_TYPE,
		"x-amz-checksum-sha256": conditions.checksumSha256,
	};
	if (conditions.expectedEtag === null) {
		headers["If-None-Match"] = "*";
	} else if (conditions.expectedEtag !== undefined) {
		headers["If-Match"] = `"${conditions.expectedEtag}"`;
	}

	const signed = await client(config).sign(new Request(objectUrl(config, key, expiresIn), { headers, method: "PUT" }), {
		aws: { allHeaders: true, signQuery: true },
	});
	return { expiresAt, headers, url: signed.url };
}

export async function signDownload(
	config: R2SigningConfig,
	key: string,
	now: number,
): Promise<{ expiresAt: number; url: string }> {
	const expiresAt = now + PRESIGNED_URL_LIFETIME_SECONDS;
	const signed = await client(config).sign(new Request(objectUrl(config, key, PRESIGNED_URL_LIFETIME_SECONDS)), {
		aws: { signQuery: true },
	});
	return { expiresAt, url: signed.url };
}
