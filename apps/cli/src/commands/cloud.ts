import { CloudApiError, createCloudPortal, revokeCloudCredential } from "../cloud/client.js";
import { removeCloudCredentials } from "../cloud/credentials.js";
import { type CloudLinkEvents, linkCloudRemote } from "../cloud/link.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { PackbatError } from "../core/errors.js";
import { resolveHome } from "../core/home.js";
import { openUrl } from "../core/open-url.js";
import { skippedOffboxConfig } from "../core/setup.js";

const USAGE = `Usage: packbat cloud link [--annual]
       packbat cloud unlink
       packbat cloud billing
`;

const events: CloudLinkEvents = {
	onDeviceCode(code, verificationUri, opened) {
		process.stdout.write(`GitHub code: ${code}\n`);
		if (!opened) process.stdout.write(`Open: ${verificationUri}\n`);
		process.stdout.write("Waiting for GitHub authorization…\n");
	},
	onCheckout(url, opened) {
		if (!opened) process.stdout.write(`Open Stripe Checkout: ${url}\n`);
	},
	onWaitingForPayment() {
		process.stdout.write("Waiting for Stripe Checkout…\n");
	},
};

async function link(argv: string[]): Promise<number> {
	if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--annual")) {
		process.stderr.write(USAGE);
		return 1;
	}
	const home = resolveHome();
	const config = loadConfig(home);
	if (config.offbox.mode !== "configured") {
		throw new PackbatError("off-box encryption is not configured; run `packbat init` and choose Packbat Cloud");
	}
	if (config.offbox.remotes.some((remote) => remote.type === "cloud")) {
		process.stdout.write("Packbat Cloud is already linked.\n");
		return 0;
	}
	const remote = await linkCloudRemote(home, argv[0] === "--annual" ? "year" : "month", events);
	saveConfig(home, {
		...config,
		offbox: { ...config.offbox, remotes: [...config.offbox.remotes, remote] },
	});
	process.stdout.write("Packbat Cloud linked. The next sync backfills the full local archive.\n");
	return 0;
}

async function unlink(argv: string[]): Promise<number> {
	if (argv.length !== 0) {
		process.stderr.write(USAGE);
		return 1;
	}
	const home = resolveHome();
	const config = loadConfig(home);
	try {
		await revokeCloudCredential(home);
	} catch (error) {
		if (!(error instanceof CloudApiError && error.status === 401)) {
			throw error;
		}
	}
	await removeCloudCredentials(home);
	if (config.offbox.mode === "configured") {
		const remotes = config.offbox.remotes.filter((remote) => remote.type !== "cloud");
		const first = remotes[0];
		saveConfig(
			home,
			first === undefined
				? { ...config, offbox: skippedOffboxConfig() }
				: { ...config, offbox: { ...config.offbox, remotes: [first, ...remotes.slice(1)] } },
		);
	}
	process.stdout.write("Packbat Cloud unlinked. Stored ciphertext remains in the Cloud account.\n");
	return 0;
}

async function billing(argv: string[]): Promise<number> {
	if (argv.length !== 0) {
		process.stderr.write(USAGE);
		return 1;
	}
	const url = await createCloudPortal(resolveHome());
	if (!(await openUrl(url))) {
		process.stdout.write(`Open Stripe billing: ${url}\n`);
	}
	return 0;
}

export async function runCloud(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case "link":
			return await link(rest);
		case "unlink":
			return await unlink(rest);
		case "billing":
			return await billing(rest);
		default:
			process.stderr.write(USAGE);
			return 1;
	}
}
