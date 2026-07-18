import { describe, expect, test } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };
import { parseCloudRecoveryLocator, renderRecoveryKit } from "./recovery-kit.js";

describe("recovery kit", () => {
	test("renders the identity, remote locator, recovery commands, and loss warning", () => {
		const kit = renderRecoveryKit({
			identity: "AGE-SECRET-KEY-1SYNTHETICIDENTITY",
			recipient: "age1syntheticrecipient12345678",
			remotes: [
				{
					type: "s3-compatible",
					destination: "vault:agent-sessions/archive",
					endpoint: "https://objects.example.com",
					bucket: "agent-sessions",
					prefix: "archive",
				},
			],
			createdAt: "2026-07-13T10:11:12.000Z",
		});

		expect(kit).toBe(`Packbat recovery kit
Packbat version: ${packageMetadata.version}
format: 2
created: 2026-07-13T10:11:12.000Z

Age identity
AGE-SECRET-KEY-1SYNTHETICIDENTITY

Age recipient
age1syntheticrecipient12345678

Remote
type: s3-compatible
endpoint: https://objects.example.com
bucket: agent-sessions
prefix: archive
destination: vault:agent-sessions/archive

Fresh-machine setup
Configure rclone access to vault:agent-sessions/archive, then run:
packbat init --yes --offbox remote --offbox-remote vault:agent-sessions/archive --age-recipient age1syntheticrecipient12345678 --rclone-config default

Fresh-machine restore
packbat restore --from-remote --identity <kit-file> <unit> --machine <source-machine>

Raw age fallback
age -d -i <kit-file> -o <archive-file> <archive-file>.age

If every copy of this identity is lost, nobody can recover this archive.
`);
	});

	test("lists every remote and an explicit restore command for additional remotes", () => {
		const kit = renderRecoveryKit({
			identity: "AGE-SECRET-KEY-1SYNTHETICIDENTITY",
			recipient: "age1syntheticrecipient12345678",
			remotes: [
				{ type: "rclone", destination: "first:archive" },
				{ type: "rclone", destination: "second:archive" },
			],
			createdAt: "2026-07-13T10:11:12.000Z",
		});

		expect(kit).toContain("Remote 1\ntype: rclone\ndestination: first:archive");
		expect(kit).toContain("Remote 2\ntype: rclone\ndestination: second:archive");
		expect(kit).toContain("--remote second:archive");
	});

	test.each([
		["google-drive" as const, "Google Drive"],
		["dropbox" as const, "Dropbox"],
	])("keeps %s authorization material out of the recovery kit", (provider, displayName) => {
		const kit = renderRecoveryKit({
			identity: "AGE-SECRET-KEY-1SYNTHETICIDENTITY",
			recipient: "age1syntheticrecipient12345678",
			remotes: [{ type: "oauth", provider, destination: "packbat:packbat" }],
			createdAt: "2026-07-16T10:11:12.000Z",
		});

		expect(kit).toContain(`type: oauth\nprovider: ${provider}\ndestination: packbat:packbat`);
		expect(kit).toContain(`Run packbat init, choose ${displayName}, and authorize this destination in the browser.`);
		expect(kit).toContain(
			"The recovery kit intentionally contains no access token, refresh token, or OAuth client secret.",
		);
		expect(kit).not.toContain("--rclone-config default");
		expect(kit).not.toContain("token =");
	});

	test("records the opaque Cloud machine locator without credentials", () => {
		const kit = renderRecoveryKit({
			identity: "AGE-SECRET-KEY-1SYNTHETICIDENTITY",
			recipient: "age1syntheticrecipient12345678",
			remotes: [{ type: "cloud", destination: "Packbat Cloud", machineRemoteId: "abcdefghijklmnopqrstuvwx" }],
			createdAt: "2026-07-17T10:11:12.000Z",
		});

		expect(kit).toContain("type: cloud\ndestination: Packbat Cloud\nmachine remote: abcdefghijklmnopqrstuvwx");
		expect(kit).toContain("Run packbat cloud link --restore-from <kit-file> on the new machine.");
		expect(kit).toContain("The recovery kit intentionally contains no Packbat Cloud credential.");
		expect(kit).not.toContain("access token");
		expect(kit).not.toContain("refresh token");
	});

	test("parses the Cloud recipient and opaque locator for fresh-machine setup", () => {
		const kit = renderRecoveryKit({
			identity: "AGE-SECRET-KEY-1SYNTHETICIDENTITY",
			recipient: "age1syntheticrecipient12345678",
			remotes: [{ type: "cloud", destination: "Packbat Cloud", machineRemoteId: "abcdefghijklmnopqrstuvwx" }],
			createdAt: "2026-07-17T10:11:12.000Z",
		});

		expect(parseCloudRecoveryLocator(kit)).toEqual({
			machineRemoteId: "abcdefghijklmnopqrstuvwx",
			recipient: "age1syntheticrecipient12345678",
		});
	});
});
