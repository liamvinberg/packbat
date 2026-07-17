import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { RemoteConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { pathExists } from "../core/fs.js";
import type { PackbatHome } from "../core/home.js";
import { openUrl } from "../core/open-url.js";
import {
	cloudBillingStatus,
	cloudClientConfig,
	createCloudCheckout,
	createCloudMachine,
	exchangeGitHubToken,
} from "./client.js";
import { credentialsFromTokenResponse, readCloudCredentials, saveCloudCredentials } from "./credentials.js";
import { pollGitHubDeviceFlow, requestGitHubDeviceCode } from "./device-flow.js";

const CHECKOUT_POLL_INTERVAL_MS = 3_000;
const CHECKOUT_TIMEOUT_MS = 31 * 60 * 1_000;

export interface CloudLinkEvents {
	onCheckout(url: string, opened: boolean): void;
	onDeviceCode(code: string, verificationUri: string, opened: boolean): void;
	onWaitingForPayment(): void;
}

async function ensureCredentials(home: PackbatHome, events: CloudLinkEvents): Promise<void> {
	if (await pathExists(home.cloudCredentialsPath)) {
		await readCloudCredentials(home);
		return;
	}
	const { githubClientId } = await cloudClientConfig();
	const device = await requestGitHubDeviceCode(githubClientId);
	const opened = await openUrl(device.verificationUri);
	events.onDeviceCode(device.userCode, device.verificationUri, opened);
	let githubAccessToken: string | undefined = await pollGitHubDeviceFlow({
		clientId: githubClientId,
		deviceCode: device,
	});
	try {
		const linked = await exchangeGitHubToken(githubAccessToken);
		await saveCloudCredentials(home, credentialsFromTokenResponse(linked, `link-${randomUUID()}`));
	} finally {
		githubAccessToken = undefined;
	}
}

async function ensureActiveSubscription(
	home: PackbatHome,
	interval: "month" | "year",
	events: CloudLinkEvents,
): Promise<void> {
	let status = await cloudBillingStatus(home);
	if (status.state === "active" && status.canUpload) {
		return;
	}
	const credentials = await readCloudCredentials(home);
	const checkoutUrl = await createCloudCheckout(home, interval, credentials.checkoutIdempotencyKey);
	const opened = await openUrl(checkoutUrl);
	events.onCheckout(checkoutUrl, opened);
	events.onWaitingForPayment();
	const deadline = Date.now() + CHECKOUT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await wait(CHECKOUT_POLL_INTERVAL_MS);
		status = await cloudBillingStatus(home);
		if (status.state === "active" && status.canUpload) {
			return;
		}
	}
	throw new PackbatError("Stripe Checkout did not activate Packbat Cloud; run `packbat cloud link` again");
}

export async function linkCloudRemote(
	home: PackbatHome,
	interval: "month" | "year",
	events: CloudLinkEvents,
): Promise<Extract<RemoteConfig, { type: "cloud" }>> {
	await ensureCredentials(home, events);
	await ensureActiveSubscription(home, interval, events);
	return { type: "cloud", machineRemoteId: await createCloudMachine(home) };
}
