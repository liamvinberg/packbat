import { existsSync } from "node:fs";
import { loadConfig, saveConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import type { PackbatHome } from "../core/home.js";
import { openUrl } from "../core/open-url.js";
import { skippedOffboxConfig, writeInitConfig } from "../core/setup.js";
import { readCloudRecoveryLocator } from "../offbox/recovery-kit.js";
import { CloudApiError, createCloudPortal, revokeCloudCredential } from "./client.js";
import { CloudCredentialError, removeCloudCredentials } from "./credentials.js";
import { type CloudLinkEvents, ensureCloudAccount, ensureCloudUploadReady, linkCloudRemote } from "./link.js";

export interface AddCloudRemoteResult {
	kind: "already-linked" | "linked";
	machineRemoteId: string;
}

export async function addCloudRemote(
	home: PackbatHome,
	interval: "month" | "year",
	events: CloudLinkEvents,
): Promise<AddCloudRemoteResult> {
	const config = loadConfig(home);
	if (config.offbox.mode !== "configured") {
		throw new PackbatError("off-box encryption is not configured; run `packbat init` and choose Packbat Cloud");
	}
	const current = config.offbox.remotes.find((remote) => remote.type === "cloud");
	if (current !== undefined) {
		await ensureCloudUploadReady(home, interval, events);
		return { kind: "already-linked", machineRemoteId: current.machineRemoteId };
	}
	const remote = await linkCloudRemote(home, interval, events);
	saveConfig(home, {
		...config,
		offbox: { ...config.offbox, remotes: [...config.offbox.remotes, remote] },
	});
	return { kind: "linked", machineRemoteId: remote.machineRemoteId };
}

export async function addCloudRemoteFromRecoveryKit(
	home: PackbatHome,
	kitPath: string,
	events: CloudLinkEvents,
): Promise<{ kind: "already-linked" | "linked"; machineRemoteId: string }> {
	const locator = await readCloudRecoveryLocator(kitPath);
	await ensureCloudAccount(home, events);
	const remote = { type: "cloud" as const, machineRemoteId: locator.machineRemoteId };
	if (!existsSync(home.configPath)) {
		await writeInitConfig(home, home.defaultArchiveRoot, {
			mode: "configured",
			recipient: locator.recipient,
			remotes: [remote],
		});
		return { kind: "linked", machineRemoteId: locator.machineRemoteId };
	}
	const config = loadConfig(home);
	if (config.offbox.mode === "configured") {
		if (config.offbox.recipient !== locator.recipient) {
			throw new PackbatError("recovery kit recipient does not match the configured off-box recipient");
		}
		const current = config.offbox.remotes.find((candidate) => candidate.type === "cloud");
		if (current !== undefined && current.machineRemoteId !== locator.machineRemoteId) {
			throw new PackbatError("a different Packbat Cloud machine is already configured");
		}
		if (current !== undefined) {
			return { kind: "already-linked", machineRemoteId: current.machineRemoteId };
		}
		saveConfig(home, { ...config, offbox: { ...config.offbox, remotes: [...config.offbox.remotes, remote] } });
	} else {
		saveConfig(home, {
			...config,
			offbox: { mode: "configured", recipient: locator.recipient, remotes: [remote] },
		});
	}
	return { kind: "linked", machineRemoteId: locator.machineRemoteId };
}

export async function unlinkCloudRemote(home: PackbatHome): Promise<void> {
	const config = loadConfig(home);
	try {
		await revokeCloudCredential(home);
	} catch (error) {
		if (!(error instanceof CloudCredentialError || (error instanceof CloudApiError && error.status === 401))) {
			throw error;
		}
	}
	await removeCloudCredentials(home);
	if (config.offbox.mode !== "configured") {
		return;
	}
	const remotes = config.offbox.remotes.filter((remote) => remote.type !== "cloud");
	const first = remotes[0];
	saveConfig(
		home,
		first === undefined
			? { ...config, offbox: skippedOffboxConfig() }
			: { ...config, offbox: { ...config.offbox, remotes: [first, ...remotes.slice(1)] } },
	);
}

export async function openCloudBilling(home: PackbatHome): Promise<{ opened: boolean; url: string }> {
	const url = await createCloudPortal(home);
	return { opened: await openUrl(url), url };
}
