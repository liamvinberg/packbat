import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scheduleKind } from "./scheduler.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("scheduleKind", () => {
	test("falls back to cron when the systemd user manager does not answer", async () => {
		const root = await mkdtemp(join(tmpdir(), "blotter-systemctl-"));
		roots.push(root);
		const systemctl = join(root, "systemctl");
		await writeFile(systemctl, "#!/bin/sh\nexit 1\n");
		await chmod(systemctl, 0o755);

		expect(scheduleKind({ PATH: root })).toBe("cron");
	});
});
