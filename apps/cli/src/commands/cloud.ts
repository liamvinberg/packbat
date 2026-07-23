import { cloudEnabled } from "../cloud/enabled.js";
import type { CloudLinkEvents } from "../cloud/link.js";
import { addCloudRemote, addCloudRemoteFromRecoveryKit, openCloudBilling, unlinkCloudRemote } from "../cloud/manage.js";
import { resolveHome } from "../core/home.js";

const USAGE = `Usage: packbat cloud link [--annual | --restore-from <kit-file>]
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
	const restoreFrom = argv[0] === "--restore-from" && argv.length === 2 ? argv[1] : undefined;
	if (!(argv.length === 0 || (argv.length === 1 && argv[0] === "--annual") || restoreFrom !== undefined)) {
		process.stderr.write(USAGE);
		return 1;
	}
	const result =
		restoreFrom === undefined
			? await addCloudRemote(resolveHome(), argv[0] === "--annual" ? "year" : "month", events)
			: await addCloudRemoteFromRecoveryKit(resolveHome(), restoreFrom, events);
	if (result.kind === "already-linked") {
		process.stdout.write("Packbat Cloud is already linked.\n");
	} else if (restoreFrom === undefined) {
		process.stdout.write("Packbat Cloud linked. The next sync backfills the full local archive.\n");
	} else {
		process.stdout.write("Packbat Cloud restore access linked from the recovery kit.\n");
	}
	process.stdout.write(
		`Save this with the recovery kit:\ntype: cloud\ndestination: Packbat Cloud\nmachine remote: ${result.machineRemoteId}\nFresh-machine setup: packbat cloud link --restore-from <kit-file>\n`,
	);
	return 0;
}

async function unlink(argv: string[]): Promise<number> {
	if (argv.length !== 0) {
		process.stderr.write(USAGE);
		return 1;
	}
	await unlinkCloudRemote(resolveHome());
	process.stdout.write("Packbat Cloud unlinked. Stored ciphertext remains in the Cloud account.\n");
	return 0;
}

async function billing(argv: string[]): Promise<number> {
	if (argv.length !== 0) {
		process.stderr.write(USAGE);
		return 1;
	}
	const billing = await openCloudBilling(resolveHome());
	if (!billing.opened) {
		process.stdout.write(`Open Stripe billing: ${billing.url}\n`);
	}
	return 0;
}

export async function runCloud(argv: string[]): Promise<number> {
	if (!cloudEnabled()) {
		process.stderr.write("Packbat Cloud is not available. Off-box copies go to a remote you own, run `packbat init`.\n"); // DRAFT copy
		return 1;
	}
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
