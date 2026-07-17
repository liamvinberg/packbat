import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { PackbatError } from "../core/errors.js";

const DEFAULT_DEVICE_CODE_URL = "https://github.com/login/device/code";
const DEFAULT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_NETWORK_BACKOFF_SECONDS = 60;

const deviceCodeSchema = z.object({
	device_code: z.string().min(1),
	expires_in: z.number().int().positive(),
	interval: z.number().int().positive(),
	user_code: z.string().min(1),
	verification_uri: z.url(),
});

const tokenResponseSchema = z.union([
	z.object({ access_token: z.string().min(1) }),
	z.object({ error: z.string().min(1) }),
]);

export interface GitHubDeviceCode {
	deviceCode: string;
	expiresAt: number;
	intervalSeconds: number;
	userCode: string;
	verificationUri: string;
}

export type DevicePollOutcome = "authorization-pending" | "network-timeout" | "slow-down";

export interface PollGitHubDeviceFlowOptions {
	clientId: string;
	deviceCode: GitHubDeviceCode;
	signal?: AbortSignal;
}

export function nextPollIntervalSeconds(current: number, outcome: DevicePollOutcome): number {
	switch (outcome) {
		case "authorization-pending":
			return current;
		case "slow-down":
			return current + 5;
		case "network-timeout":
			return Math.min(current * 2, MAX_NETWORK_BACKOFF_SECONDS);
	}
}

function formBody(fields: Readonly<Record<string, string>>): string {
	return new URLSearchParams(fields).toString();
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
	if (!response.ok) {
		throw new PackbatError(`${operation} failed (HTTP ${response.status})`);
	}
	try {
		return await response.json();
	} catch {
		throw new PackbatError(`${operation} returned an invalid response`);
	}
}

export async function requestGitHubDeviceCode(clientId: string, signal?: AbortSignal): Promise<GitHubDeviceCode> {
	const deviceCodeUrl = process.env.PACKBAT_GITHUB_DEVICE_CODE_URL?.trim() || DEFAULT_DEVICE_CODE_URL;
	const response = await fetch(deviceCodeUrl, {
		body: formBody({ client_id: clientId }),
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
		...(signal === undefined ? {} : { signal }),
	});
	const result = deviceCodeSchema.safeParse(await responseJson(response, "GitHub device authorization"));
	if (!result.success) {
		throw new PackbatError("GitHub device authorization returned an invalid response");
	}
	return {
		deviceCode: result.data.device_code,
		expiresAt: Date.now() + result.data.expires_in * 1_000,
		intervalSeconds: result.data.interval,
		userCode: result.data.user_code,
		verificationUri: result.data.verification_uri,
	};
}

function pollSignal(deadline: number, signal: AbortSignal | undefined): AbortSignal {
	const remaining = Math.max(1, deadline - Date.now());
	const timeout = AbortSignal.timeout(Math.min(remaining, 30_000));
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function isCallerAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true && error instanceof Error && error.name === "AbortError";
}

async function waitForNextPoll(
	deadline: number,
	intervalSeconds: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new PackbatError("GitHub device authorization expired");
	}
	try {
		await wait(Math.min(intervalSeconds * 1_000, remaining), undefined, signal === undefined ? {} : { signal });
	} catch (error) {
		if (isCallerAbort(error, signal)) {
			throw new PackbatError("GitHub device authorization cancelled");
		}
		throw error;
	}
	if (Date.now() >= deadline) {
		throw new PackbatError("GitHub device authorization expired");
	}
}

export async function pollGitHubDeviceFlow(options: PollGitHubDeviceFlowOptions): Promise<string> {
	const accessTokenUrl = process.env.PACKBAT_GITHUB_ACCESS_TOKEN_URL?.trim() || DEFAULT_ACCESS_TOKEN_URL;
	let intervalSeconds = options.deviceCode.intervalSeconds;
	for (;;) {
		await waitForNextPoll(options.deviceCode.expiresAt, intervalSeconds, options.signal);
		let response: Response;
		try {
			response = await fetch(accessTokenUrl, {
				body: formBody({
					client_id: options.clientId,
					device_code: options.deviceCode.deviceCode,
					grant_type: DEVICE_GRANT_TYPE,
				}),
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				method: "POST",
				signal: pollSignal(options.deviceCode.expiresAt, options.signal),
			});
		} catch (error) {
			if (isCallerAbort(error, options.signal)) {
				throw new PackbatError("GitHub device authorization cancelled");
			}
			if (Date.now() >= options.deviceCode.expiresAt) {
				throw new PackbatError("GitHub device authorization expired");
			}
			intervalSeconds = nextPollIntervalSeconds(intervalSeconds, "network-timeout");
			continue;
		}

		const result = tokenResponseSchema.safeParse(await responseJson(response, "GitHub device authorization"));
		if (!result.success) {
			throw new PackbatError("GitHub device authorization returned an invalid response");
		}
		if ("access_token" in result.data) {
			return result.data.access_token;
		}
		switch (result.data.error) {
			case "authorization_pending":
				intervalSeconds = nextPollIntervalSeconds(intervalSeconds, "authorization-pending");
				break;
			case "slow_down":
				intervalSeconds = nextPollIntervalSeconds(intervalSeconds, "slow-down");
				break;
			case "access_denied":
				throw new PackbatError("GitHub device authorization was denied");
			case "expired_token":
			case "token_expired":
				throw new PackbatError("GitHub device authorization expired");
			default:
				throw new PackbatError(`GitHub device authorization failed (${result.data.error})`);
		}
	}
}
