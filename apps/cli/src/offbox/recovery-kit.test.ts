import { describe, expect, test } from "vitest";
import { recipientChallenge, renderRecoveryKit } from "./recovery-kit.js";

describe("recovery kit", () => {
	test("renders the identity, remote locator, recovery commands, and loss warning", () => {
		const kit = renderRecoveryKit({
			identity: "AGE-SECRET-KEY-1SYNTHETICIDENTITY",
			recipient: "age1syntheticrecipient12345678",
			remote: {
				type: "s3-compatible",
				destination: "backup:blotter/archive",
				endpoint: "https://objects.example.com",
				bucket: "blotter",
				prefix: "archive",
			},
			createdAt: "2026-07-13T10:11:12.000Z",
		});

		expect(kit).toBe(`blotter recovery kit
blotter version: 0.1.0
format: 1
created: 2026-07-13T10:11:12.000Z

Age identity
AGE-SECRET-KEY-1SYNTHETICIDENTITY

Age recipient
age1syntheticrecipient12345678

Remote
type: s3-compatible
endpoint: https://objects.example.com
bucket: blotter
prefix: archive
destination: backup:blotter/archive

Fresh-machine setup
Configure rclone access to backup:blotter/archive, then run:
blotter init --yes --offbox remote --offbox-remote backup:blotter/archive --age-recipient age1syntheticrecipient12345678 --rclone-config default

Fresh-machine restore
blotter restore --from-remote --identity <kit-file> <unit> --machine <source-machine>

Raw age fallback
age -d -i <kit-file> -o <archive-file> <archive-file>.age

If every copy of this identity is lost, nobody can recover this archive.
`);
	});

	test("uses the last eight recipient characters as the custody challenge", () => {
		expect(recipientChallenge("age1syntheticrecipient12345678")).toBe("12345678");
	});
});
