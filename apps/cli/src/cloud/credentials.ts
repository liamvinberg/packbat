import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { PackbatError } from "../core/errors.js";
import { isEnoent } from "../core/fs.js";
import type { PackbatHome } from "../core/home.js";
import { writePrivateFile } from "../core/private-file.js";

export const cloudTokenResponseSchema = z.strictObject({
	accessToken: z.string().min(1),
	accessTokenExpiresAt: z.iso.datetime(),
	account: z.object({
		graceEndsAt: z.iso.datetime().nullable(),
		id: z.string().uuid(),
		quotaBytes: z.number().int().nonnegative().safe(),
		reservedBytes: z.number().int().nonnegative().safe(),
		subscriptionState: z.enum(["active", "grace", "inactive"]),
		usedBytes: z.number().int().nonnegative().safe(),
		githubLogin: z.string().min(1).optional(),
	}),
	refreshToken: z.string().min(1),
	refreshTokenExpiresAt: z.iso.datetime(),
	tokenType: z.literal("Bearer"),
});

export type CloudTokenResponse = z.infer<typeof cloudTokenResponseSchema>;

const cloudCredentialsSchema = z.strictObject({
	v: z.literal(1),
	accessToken: z.string().min(1),
	accessTokenExpiresAt: z.iso.datetime(),
	checkoutIdempotencyKey: z.string().min(1).max(128),
	refreshToken: z.string().min(1),
	refreshTokenExpiresAt: z.iso.datetime(),
});

export type CloudCredentials = z.infer<typeof cloudCredentialsSchema>;

export function credentialsFromTokenResponse(
	response: CloudTokenResponse,
	checkoutIdempotencyKey: string,
): CloudCredentials {
	return {
		v: 1,
		accessToken: response.accessToken,
		accessTokenExpiresAt: response.accessTokenExpiresAt,
		checkoutIdempotencyKey,
		refreshToken: response.refreshToken,
		refreshTokenExpiresAt: response.refreshTokenExpiresAt,
	};
}

export async function readCloudCredentials(home: PackbatHome): Promise<CloudCredentials> {
	let raw: string;
	try {
		raw = await readFile(home.cloudCredentialsPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			throw new PackbatError("Packbat Cloud is not linked; run `packbat cloud link`");
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new PackbatError("Packbat Cloud credentials are invalid; run `packbat cloud link` again");
	}
	const result = cloudCredentialsSchema.safeParse(value);
	if (!result.success) {
		throw new PackbatError("Packbat Cloud credentials are invalid; run `packbat cloud link` again");
	}
	return result.data;
}

export async function saveCloudCredentials(home: PackbatHome, credentials: CloudCredentials): Promise<void> {
	await writePrivateFile(home.cloudCredentialsPath, `${JSON.stringify(credentials, null, "\t")}\n`);
}

export async function removeCloudCredentials(home: PackbatHome): Promise<void> {
	await rm(home.cloudCredentialsPath, { force: true });
}

async function withCredentialLock<T>(home: PackbatHome, action: () => Promise<T>): Promise<T> {
	const lockPath = join(home.statePath, "cloud-credential.lock");
	await mkdir(home.statePath, { recursive: true });
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await mkdir(lockPath);
			try {
				return await action();
			} finally {
				await rm(lockPath, { recursive: true, force: true });
			}
		} catch (error) {
			if (!isEnoent(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			await wait(50);
		}
	}
	throw new PackbatError("Packbat Cloud credentials are busy; try again");
}

async function parseTokenResponse(response: Response): Promise<CloudTokenResponse> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new PackbatError("Packbat Cloud returned an invalid credential response");
	}
	const result = cloudTokenResponseSchema.safeParse(body);
	if (!response.ok || !result.success) {
		throw new PackbatError("Packbat Cloud authorization expired; run `packbat cloud link` again");
	}
	return result.data;
}

export async function refreshCloudCredentials(home: PackbatHome, apiBaseUrl: string): Promise<CloudCredentials> {
	return await withCredentialLock(home, async () => {
		const current = await readCloudCredentials(home);
		if (Date.parse(current.accessTokenExpiresAt) > Date.now() + 30_000) {
			return current;
		}
		const response = await fetch(`${apiBaseUrl}/v1/auth/refresh`, {
			body: JSON.stringify({ refreshToken: current.refreshToken }),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
		const token = await parseTokenResponse(response);
		const rotated = credentialsFromTokenResponse(token, current.checkoutIdempotencyKey);
		await saveCloudCredentials(home, rotated);
		return rotated;
	});
}

export async function cloudAccessToken(home: PackbatHome, apiBaseUrl: string): Promise<string> {
	const credentials = await readCloudCredentials(home);
	if (Date.parse(credentials.accessTokenExpiresAt) > Date.now() + 30_000) {
		return credentials.accessToken;
	}
	return (await refreshCloudCredentials(home, apiBaseUrl)).accessToken;
}
