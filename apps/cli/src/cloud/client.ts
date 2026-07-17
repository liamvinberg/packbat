import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { PackbatError } from "../core/errors.js";
import type { PackbatHome } from "../core/home.js";
import { type CloudTokenResponse, cloudAccessToken, cloudTokenResponseSchema } from "./credentials.js";

const DEFAULT_API_BASE_URL = "https://api.packbat.dev";

const billingStatusSchema = z.strictObject({
	billingStarted: z.boolean(),
	canRestore: z.boolean(),
	canUpload: z.boolean(),
	graceEndsAt: z.iso.datetime().nullable(),
	quotaBytes: z.number().int().nonnegative().safe(),
	reservedBytes: z.number().int().nonnegative().safe(),
	state: z.enum(["active", "grace", "inactive"]),
	usedBytes: z.number().int().nonnegative().safe(),
});

const urlSchema = z.strictObject({ url: z.url() });
const machineSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{24}$/u) });
const uploadSchema = z.union([
	z.strictObject({
		reservationId: z.uuid(),
		state: z.literal("pending"),
		upload: z.strictObject({
			expiresAt: z.iso.datetime(),
			headers: z.record(z.string(), z.string()),
			url: z.url(),
		}),
	}),
	z.strictObject({ reservationId: z.uuid(), state: z.literal("completed"), etag: z.string().min(1) }),
	z.strictObject({ reservationId: z.uuid(), state: z.literal("expired") }),
]);
const finalizeSchema = z.strictObject({ etag: z.string().min(1) });
const clientConfigSchema = z.strictObject({ githubClientId: z.string().min(1) });

export type CloudBillingStatus = z.infer<typeof billingStatusSchema>;

export class CloudApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(
			code === "subscription_required"
				? "Packbat Cloud uploads are frozen; run `packbat status` for subscription and restore details"
				: code === "quota_exceeded"
					? "Packbat Cloud quota is full; no stored ciphertext was deleted"
					: `Packbat Cloud request failed (${code})`,
		);
	}
}

export function cloudApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env.PACKBAT_CLOUD_API_URL?.trim() || DEFAULT_API_BASE_URL;
}

async function responseBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function parsedResponse<T>(response: Response, schema: z.ZodType<T>, operation: string): Promise<T> {
	const body = await responseBody(response);
	if (!response.ok) {
		const error = z.object({ error: z.string().min(1) }).safeParse(body);
		throw new CloudApiError(response.status, error.success ? error.data.error : "request_failed");
	}
	const result = schema.safeParse(body);
	if (!result.success) {
		throw new PackbatError(`Packbat Cloud returned an invalid ${operation} response`);
	}
	return result.data;
}

async function authenticatedFetch(
	home: PackbatHome,
	path: string,
	init: RequestInit = {},
	apiBaseUrl = cloudApiBaseUrl(),
): Promise<Response> {
	const token = await cloudAccessToken(home, apiBaseUrl);
	return await fetch(`${apiBaseUrl}${path}`, {
		...init,
		headers: { ...init.headers, Authorization: `Bearer ${token}` },
	});
}

export async function cloudClientConfig(apiBaseUrl = cloudApiBaseUrl()): Promise<{ githubClientId: string }> {
	return await parsedResponse(await fetch(`${apiBaseUrl}/v1/client`), clientConfigSchema, "client configuration");
}

export async function exchangeGitHubToken(githubAccessToken: string): Promise<CloudTokenResponse> {
	return await parsedResponse(
		await fetch(`${cloudApiBaseUrl()}/v1/auth/github/exchange`, {
			body: JSON.stringify({ githubAccessToken }),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		}),
		cloudTokenResponseSchema,
		"account link",
	);
}

export async function cloudBillingStatus(home: PackbatHome): Promise<CloudBillingStatus> {
	return await parsedResponse(
		await authenticatedFetch(home, "/v1/billing/status"),
		billingStatusSchema,
		"billing status",
	);
}

export async function createCloudCheckout(
	home: PackbatHome,
	interval: "month" | "year",
	idempotencyKey: string,
): Promise<string> {
	return (
		await parsedResponse(
			await authenticatedFetch(home, "/v1/billing/checkout", {
				body: JSON.stringify({ idempotencyKey, interval }),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			}),
			urlSchema,
			"Checkout",
		)
	).url;
}

export async function createCloudPortal(home: PackbatHome): Promise<string> {
	return (
		await parsedResponse(
			await authenticatedFetch(home, "/v1/billing/portal", {
				body: "{}",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			}),
			urlSchema,
			"billing portal",
		)
	).url;
}

export async function createCloudMachine(home: PackbatHome): Promise<string> {
	return (
		await parsedResponse(
			await authenticatedFetch(home, "/v1/machines", {
				body: "{}",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			}),
			machineSchema,
			"machine registration",
		)
	).id;
}

export async function revokeCloudCredential(home: PackbatHome): Promise<void> {
	const response = await authenticatedFetch(home, "/v1/auth/credential", { method: "DELETE" });
	if (response.status !== 204) {
		const body = await responseBody(response);
		const error = z.object({ error: z.string() }).safeParse(body);
		throw new CloudApiError(response.status, error.success ? error.data.error : "request_failed");
	}
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("base64");
}

function idempotencyKey(machineRemoteId: string, sweepId: string, logicalObjectKey: string, checksum: string): string {
	return createHash("sha256")
		.update(`${machineRemoteId}\0${sweepId}\0${logicalObjectKey}\0${checksum}`)
		.digest("base64url");
}

export async function uploadCloudObject(options: {
	home: PackbatHome;
	machineRemoteId: string;
	logicalObjectKey: string;
	path: string;
	sweepId: string;
	expectedArchiveCount?: number;
	expectedIndexEtag?: string | null;
}): Promise<string> {
	const [file, checksumSha256] = await Promise.all([stat(options.path), sha256(options.path)]);
	const reservation = await parsedResponse(
		await authenticatedFetch(options.home, "/v1/uploads/reservations", {
			body: JSON.stringify({
				checksumSha256,
				expectedBytes: file.size,
				idempotencyKey: idempotencyKey(
					options.machineRemoteId,
					options.sweepId,
					options.logicalObjectKey,
					checksumSha256,
				),
				logicalObjectKey: options.logicalObjectKey,
				machineRemoteId: options.machineRemoteId,
				sweepId: options.sweepId,
				...(options.expectedArchiveCount === undefined ? {} : { expectedArchiveCount: options.expectedArchiveCount }),
				...(options.expectedIndexEtag === undefined ? {} : { expectedIndexEtag: options.expectedIndexEtag }),
			}),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		}),
		uploadSchema,
		"upload reservation",
	);
	if (reservation.state === "completed") {
		return reservation.etag;
	}
	if (reservation.state === "expired") {
		throw new PackbatError("Packbat Cloud upload reservation expired; run `packbat sync` again");
	}
	const upload = await fetch(reservation.upload.url, {
		body: createReadStream(options.path) as unknown as BodyInit,
		duplex: "half",
		headers: reservation.upload.headers,
		method: "PUT",
	} as RequestInit & { duplex: "half" });
	if (!upload.ok) {
		throw new PackbatError(`Packbat Cloud object upload failed (HTTP ${upload.status})`);
	}
	return (
		await parsedResponse(
			await authenticatedFetch(options.home, `/v1/uploads/${reservation.reservationId}/finalize`, {
				body: "{}",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			}),
			finalizeSchema,
			"upload finalization",
		)
	).etag;
}

export async function cloudDownloadUrl(
	home: PackbatHome,
	machineRemoteId: string,
	logicalObjectKey: string,
): Promise<string | null> {
	try {
		return (
			await parsedResponse(
				await authenticatedFetch(home, "/v1/downloads", {
					body: JSON.stringify({ logicalObjectKey, machineRemoteId }),
					headers: { "Content-Type": "application/json" },
					method: "POST",
				}),
				z.strictObject({ expiresAt: z.iso.datetime(), url: z.url() }),
				"download authority",
			)
		).url;
	} catch (error) {
		if (error instanceof CloudApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

export async function downloadCloudObject(
	home: PackbatHome,
	machineRemoteId: string,
	logicalObjectKey: string,
	destinationPath: string,
): Promise<void> {
	const url = await cloudDownloadUrl(home, machineRemoteId, logicalObjectKey);
	if (url === null) {
		throw new PackbatError(`Packbat Cloud object does not exist: ${logicalObjectKey}`);
	}
	const response = await fetch(url);
	if (!response.ok || response.body === null) {
		throw new PackbatError(`Packbat Cloud object download failed (HTTP ${response.status})`);
	}
	await mkdir(dirname(destinationPath), { recursive: true });
	await pipeline(
		Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
		createWriteStream(destinationPath, { flags: "wx" }),
	);
}

export function newCheckoutIdempotencyKey(): string {
	return `link-${randomUUID()}`;
}
