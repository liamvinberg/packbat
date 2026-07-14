import { accessSync, constants } from "node:fs";
import { describe, expect, test } from "vitest";
import { discoverRclone, joinRcloneDestination } from "./rclone.js";

const wellKnownRclone = ["/opt/homebrew/bin/rclone", "/usr/local/bin/rclone", "/usr/bin/rclone"].find((path) => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
});

describe("rclone destinations", () => {
	test("joins local paths and remote roots without changing their meaning", () => {
		expect(joinRcloneDestination("/tmp/remote", "machine/index.jsonl.age")).toBe("/tmp/remote/machine/index.jsonl.age");
		expect(joinRcloneDestination("/", "/machine/index.jsonl.age")).toBe("/machine/index.jsonl.age");
		expect(joinRcloneDestination("backup:", "machine/index.jsonl.age")).toBe("backup:machine/index.jsonl.age");
		expect(joinRcloneDestination("backup:bucket/root/", "machine/index.jsonl.age")).toBe(
			"backup:bucket/root/machine/index.jsonl.age",
		);
	});

	test.skipIf(wellKnownRclone === undefined)("finds rclone in a well-known location after PATH search", async () => {
		expect(await discoverRclone({ PATH: "/usr/bin" })).toBe(wellKnownRclone);
	});
});
