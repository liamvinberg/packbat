import { describe, expect, test } from "vitest";
import { renderS3Remote, renderSftpRemote } from "./rclone-conf.js";

describe("managed rclone configuration", () => {
	test("renders an S3-compatible remote with credentials inline", () => {
		expect(
			renderS3Remote({
				endpoint: "https://objects.example.com",
				accessKeyId: "access-key-id",
				secretAccessKey: "secret-access-key",
				region: "eu-north-1",
			}),
		).toBe(`[blotter]
type = s3
provider = Other
access_key_id = access-key-id
secret_access_key = secret-access-key
endpoint = https://objects.example.com
region = eu-north-1
`);
		expect(
			renderS3Remote({
				endpoint: "https://objects.example.com",
				accessKeyId: "access-key-id",
				secretAccessKey: "secret-access-key",
			}),
		).toBe(`[blotter]
type = s3
provider = Other
access_key_id = access-key-id
secret_access_key = secret-access-key
endpoint = https://objects.example.com
`);
	});

	test("renders an SFTP remote with optional connection fields", () => {
		expect(
			renderSftpRemote({
				host: "archive.example.com",
				user: "backup",
				port: 2222,
				keyFile: "/home/liam/.ssh/blotter",
			}),
		).toBe(`[blotter]
type = sftp
host = archive.example.com
user = backup
port = 2222
key_file = /home/liam/.ssh/blotter
`);
		expect(renderSftpRemote({ host: "archive.example.com", user: "backup" })).toBe(`[blotter]
type = sftp
host = archive.example.com
user = backup
`);
	});
});
