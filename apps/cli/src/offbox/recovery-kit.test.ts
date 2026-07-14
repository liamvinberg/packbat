import { describe, expect, test } from "vitest";
import { recipientChallenge, renderRecoveryKit } from "./recovery-kit.js";

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
Packbat version: 0.1.0
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

	test("uses the last eight recipient characters as the custody challenge", () => {
		expect(recipientChallenge("age1syntheticrecipient12345678")).toBe("12345678");
	});
});
