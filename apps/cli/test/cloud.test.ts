import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { generateIdentity, identityToRecipient } from "../src/offbox/age.js";
import { makeClaudeStore } from "./helpers/fixtures.js";
import { makeTempHome, runCli } from "./helpers/run-cli.js";

const homes: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
	return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse, baseUrl: string) => Promise<void>,
): Promise<string> {
	let baseUrl = "";
	const server = createServer((request, response) => {
		void handler(request, response, baseUrl).catch((error) => {
			response.writeHead(500);
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
	baseUrl = `http://127.0.0.1:${address.port}`;
	return baseUrl;
}

async function cloudLayout(): Promise<{
	home: string;
	packbatHome: string;
	archiveRoot: string;
	claudeRoot: string;
	env: Record<string, string>;
}> {
	const home = await makeTempHome();
	homes.push(home);
	const packbatHome = join(home, "packbat");
	const archiveRoot = join(home, "archive");
	const claudeConfig = join(home, "stores", "claude");
	return {
		home,
		packbatHome,
		archiveRoot,
		claudeRoot: join(claudeConfig, "projects"),
		env: {
			PACKBAT_HOME: packbatHome,
			CLAUDE_CONFIG_DIR: claudeConfig,
			CODEX_HOME: join(home, "stores", "codex"),
			PI_CODING_AGENT_SESSION_DIR: join(home, "stores", "pi"),
		},
	};
}

async function writeCredentials(packbatHome: string): Promise<void> {
	await mkdir(packbatHome, { recursive: true });
	const path = join(packbatHome, "cloud-credentials.json");
	await writeFile(
		path,
		`${JSON.stringify({
			v: 1,
			accessToken: "synthetic-access-token",
			accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
			checkoutIdempotencyKey: "synthetic-checkout",
			refreshToken: "synthetic-refresh-token",
			refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
		})}\n`,
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })));
});

describe("Packbat Cloud managed remote", () => {
	test("backfills through exact-object uploads, commits the index last, and reports entitlement state", async () => {
		const layout = await cloudLayout();
		const identity = await generateIdentity();
		const recipient = await identityToRecipient(identity);
		const machineRemoteId = "abcdefghijklmnopqrstuvwx";
		const [fixture] = await Promise.all([makeClaudeStore(layout.claudeRoot), writeCredentials(layout.packbatHome)]);
		const sourceBytes = await readFile(fixture.files[0]!.absPath);
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "cloud-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: { mode: "configured", recipient, remotes: [{ type: "cloud", machineRemoteId }] },
			})}\n`,
		);

		const reservations: Array<Record<string, unknown>> = [];
		const reservationsById = new Map<string, Record<string, unknown>>();
		const objects = new Map<string, Buffer>();
		let billingState: "active" | "grace" = "active";
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/billing/status") {
				json(response, 200, {
					billingStarted: true,
					canRestore: true,
					canUpload: billingState === "active",
					graceEndsAt: billingState === "grace" ? "2099-03-01T00:00:00.000Z" : null,
					quotaBytes: 100_000_000_000,
					reservedBytes: 0,
					state: billingState,
					usedBytes: [...objects.values()].reduce((total, value) => total + value.byteLength, 0),
				});
				return;
			}
			if (url.pathname === "/v1/downloads") {
				const input = JSON.parse((await body(request)).toString("utf8")) as { logicalObjectKey: string };
				if (!objects.has(input.logicalObjectKey)) {
					json(response, 404, { error: "object_not_found" });
					return;
				}
				json(response, 200, {
					expiresAt: "2099-01-01T00:00:00.000Z",
					url: `${origin}/objects/${Buffer.from(input.logicalObjectKey).toString("base64url")}`,
				});
				return;
			}
			if (url.pathname === "/v1/uploads/reservations") {
				const input = JSON.parse((await body(request)).toString("utf8")) as Record<string, unknown>;
				reservations.push(input);
				const id = randomUUID();
				reservationsById.set(id, input);
				json(response, 201, {
					reservationId: id,
					state: "pending",
					upload: {
						expiresAt: "2099-01-01T00:00:00.000Z",
						headers: {
							"Content-Length": String(input.expectedBytes),
							"Content-Type": "application/octet-stream",
						},
						url: `${origin}/uploads/${id}`,
					},
				});
				return;
			}
			if (url.pathname.startsWith("/uploads/") && request.method === "PUT") {
				const id = url.pathname.slice("/uploads/".length);
				const reservation = reservationsById.get(id);
				if (reservation === undefined) throw new Error("unknown reservation");
				objects.set(String(reservation.logicalObjectKey), await body(request));
				response.writeHead(200);
				response.end();
				return;
			}
			if (url.pathname.match(/^\/v1\/uploads\/[^/]+\/finalize$/u)) {
				json(response, 200, { etag: `etag-${reservations.length}` });
				return;
			}
			if (url.pathname.startsWith("/objects/")) {
				const key = Buffer.from(url.pathname.slice("/objects/".length), "base64url").toString("utf8");
				response.writeHead(200, { "Content-Type": "application/octet-stream" });
				response.end(objects.get(key));
				return;
			}
			json(response, 404, { error: "not_found" });
		});
		const env = { ...layout.env, PACKBAT_CLOUD_API_URL: baseUrl };

		const first = await runCli(["sync"], { home: layout.home, env });
		expect(first.code, first.stderr).toBe(0);
		expect(first.stdout).toContain("off-box 1/1");
		expect(reservations.length).toBeGreaterThan(1);
		expect(reservations[0]?.logicalObjectKey).toMatch(/^claude-code\//u);
		const indexReservation = reservations.at(-1);
		expect(indexReservation).toMatchObject({
			expectedArchiveCount: reservations.length - 1,
			expectedIndexEtag: null,
			logicalObjectKey: "index.jsonl.age",
		});
		expect(reservations.slice(0, -1).every((item) => item.sweepId === indexReservation?.sweepId)).toBe(true);
		expect([...objects.keys()]).not.toEqual(expect.arrayContaining([expect.stringContaining("cloud-machine/")]));

		const second = await runCli(["sync"], { home: layout.home, env });
		expect(second.code, second.stderr).toBe(0);
		expect(reservations.at(-1)).toBe(indexReservation);

		const identityPath = join(layout.home, "recovery-kit.txt");
		await writeFile(identityPath, identity, { mode: 0o600 });
		const listed = await runCli(["restore", "--from-remote", "--identity", identityPath], {
			home: layout.home,
			env,
		});
		expect(listed.code, listed.stderr).toBe(0);
		expect(listed.stdout, listed.stderr).toContain(fixture.id);
		await rm(fixture.files[0]!.absPath);
		const restored = await runCli(["restore", "--from-remote", "--identity", identityPath, fixture.id], {
			home: layout.home,
			env,
		});
		expect(restored.code, restored.stderr).toBe(0);
		expect(await readFile(fixture.files[0]!.absPath)).toEqual(sourceBytes);

		const statusResult = await runCli(["status", "--json"], { home: layout.home, env });
		expect(statusResult.code, statusResult.stderr).toBe(0);
		const status = JSON.parse(statusResult.stdout) as { offbox: Array<{ detail: string; status: string }> };
		expect(status.offbox).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ detail: expect.stringContaining("Packbat Cloud · active"), status: "ok" }),
			]),
		);
		billingState = "grace";
		const graceResult = await runCli(["status", "--json"], { home: layout.home, env });
		const grace = JSON.parse(graceResult.stdout) as { offbox: Array<{ detail: string; status: string }> };
		expect(grace.offbox).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: expect.stringContaining("uploads frozen · restore before 2099-03-01T00:00:00.000Z"),
					status: "problem",
				}),
			]),
		);
	});

	test("links from GitHub Device Flow without persisting the provider token", async () => {
		const layout = await cloudLayout();
		const recipient = await identityToRecipient(await generateIdentity());
		await mkdir(layout.packbatHome, { recursive: true });
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "device-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: {
					mode: "configured",
					recipient,
					remotes: [{ type: "rclone", destination: join(layout.home, "remote"), rcloneConfig: "default" }],
				},
			})}\n`,
		);
		const openedPath = join(layout.home, "device-opened.txt");
		const binPath = join(layout.home, "device-bin");
		await mkdir(binPath);
		const openPath = join(binPath, "open");
		await writeFile(openPath, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${openedPath}"\n`, { mode: 0o700 });
		await chmod(openPath, 0o700);
		const requests: string[] = [];
		const githubToken = "github-token-must-not-persist";
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			requests.push(url.pathname);
			if (url.pathname === "/v1/client") {
				json(response, 200, { githubClientId: "Ov23liPackbatDeviceTest" });
				return;
			}
			if (url.pathname === "/github/device") {
				const input = new URLSearchParams((await body(request)).toString("utf8"));
				expect(input.get("client_id")).toBe("Ov23liPackbatDeviceTest");
				expect(input.has("scope")).toBe(false);
				json(response, 200, {
					device_code: "synthetic-device-code",
					expires_in: 600,
					interval: 1,
					user_code: "ABCD-EFGH",
					verification_uri: `${origin}/github/verify`,
				});
				return;
			}
			if (url.pathname === "/github/token") {
				const input = new URLSearchParams((await body(request)).toString("utf8"));
				expect(input.get("client_secret")).toBeNull();
				json(response, 200, { access_token: githubToken });
				return;
			}
			if (url.pathname === "/v1/auth/github/exchange") {
				expect(JSON.parse((await body(request)).toString("utf8"))).toEqual({ githubAccessToken: githubToken });
				json(response, 200, {
					accessToken: "packbat-access-token",
					accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
					account: {
						graceEndsAt: null,
						githubLogin: "synthetic-user",
						id: "11111111-1111-4111-8111-111111111111",
						quotaBytes: 100_000_000_000,
						reservedBytes: 0,
						subscriptionState: "active",
						usedBytes: 0,
					},
					refreshToken: "packbat-refresh-token",
					refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
					tokenType: "Bearer",
				});
				return;
			}
			if (url.pathname === "/v1/billing/status") {
				json(response, 200, {
					billingStarted: true,
					canRestore: true,
					canUpload: true,
					graceEndsAt: null,
					quotaBytes: 100_000_000_000,
					reservedBytes: 0,
					state: "active",
					usedBytes: 0,
				});
				return;
			}
			if (url.pathname === "/v1/machines") {
				json(response, 201, { id: "abcdefghijklmnopqrstuvwx" });
				return;
			}
			json(response, 404, { error: "not_found" });
		});
		const result = await runCli(["cloud", "link"], {
			home: layout.home,
			env: {
				...layout.env,
				PACKBAT_CLOUD_API_URL: baseUrl,
				PACKBAT_GITHUB_ACCESS_TOKEN_URL: `${baseUrl}/github/token`,
				PACKBAT_GITHUB_DEVICE_CODE_URL: `${baseUrl}/github/device`,
				PATH: `${binPath}:${process.env.PATH ?? ""}`,
			},
		});

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("GitHub code: ABCD-EFGH");
		expect(requests).toEqual([
			"/v1/client",
			"/github/device",
			"/github/token",
			"/v1/auth/github/exchange",
			"/v1/billing/status",
			"/v1/machines",
		]);
		const credentialsPath = join(layout.packbatHome, "cloud-credentials.json");
		const credentials = await readFile(credentialsPath, "utf8");
		expect(credentials).not.toContain(githubToken);
		expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
		expect(await readFile(openedPath, "utf8")).toContain(`${baseUrl}/github/verify`);
	});

	test("link completes Checkout before registering the remote, opens billing, and unlinks locally and remotely", async () => {
		const layout = await cloudLayout();
		const identity = await generateIdentity();
		const recipient = await identityToRecipient(identity);
		const rcloneDestination = join(layout.home, "own-remote");
		await writeCredentials(layout.packbatHome);
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "link-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: {
					mode: "configured",
					recipient,
					remotes: [{ type: "rclone", destination: rcloneDestination, rcloneConfig: "default" }],
				},
			})}\n`,
		);
		const openedPath = join(layout.home, "opened.txt");
		const binPath = join(layout.home, "bin");
		await mkdir(binPath);
		const openPath = join(binPath, "open");
		await writeFile(openPath, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${openedPath}"\n`, { mode: 0o700 });
		await chmod(openPath, 0o700);

		let checkoutStarted = false;
		let credentialRevoked = false;
		const order: string[] = [];
		const machineRemoteId = "zyxwvutsrqponmlkjihgfedc";
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/billing/status") {
				order.push("status");
				json(response, 200, {
					billingStarted: checkoutStarted,
					canRestore: checkoutStarted,
					canUpload: checkoutStarted,
					graceEndsAt: null,
					quotaBytes: 100_000_000_000,
					reservedBytes: 0,
					state: checkoutStarted ? "active" : "inactive",
					usedBytes: 0,
				});
				return;
			}
			if (url.pathname === "/v1/billing/checkout") {
				order.push("checkout");
				checkoutStarted = true;
				json(response, 201, { url: `${origin}/hosted-checkout` });
				return;
			}
			if (url.pathname === "/v1/machines") {
				order.push("machine");
				json(response, 201, { id: machineRemoteId });
				return;
			}
			if (url.pathname === "/v1/billing/portal") {
				json(response, 200, { url: `${origin}/hosted-portal` });
				return;
			}
			if (url.pathname === "/v1/auth/credential" && request.method === "DELETE") {
				credentialRevoked = true;
				response.writeHead(204);
				response.end();
				return;
			}
			json(response, 404, { error: "not_found" });
		});
		const env = {
			...layout.env,
			PACKBAT_CLOUD_API_URL: baseUrl,
			PATH: `${binPath}:${process.env.PATH ?? ""}`,
		};

		const linked = await runCli(["cloud", "link"], { home: layout.home, env });
		expect(linked.code, linked.stderr).toBe(0);
		expect(linked.stdout).toContain("next sync backfills the full local archive");
		expect(order).toEqual(["status", "checkout", "status", "machine"]);
		const config = JSON.parse(await readFile(join(layout.packbatHome, "config.json"), "utf8")) as {
			offbox: { remotes: Array<Record<string, unknown>> };
		};
		expect(config.offbox.remotes).toEqual(expect.arrayContaining([{ type: "cloud", machineRemoteId }]));

		const billing = await runCli(["cloud", "billing"], { home: layout.home, env });
		expect(billing.code, billing.stderr).toBe(0);
		const opened = await readFile(openedPath, "utf8");
		expect(opened).toContain(`${baseUrl}/hosted-checkout`);
		expect(opened).toContain(`${baseUrl}/hosted-portal`);

		const unlinked = await runCli(["cloud", "unlink"], { home: layout.home, env });
		expect(unlinked.code, unlinked.stderr).toBe(0);
		expect(credentialRevoked).toBe(true);
		expect((await stat(join(layout.packbatHome, "config.json"))).mode & 0o777).toBeGreaterThan(0);
		await expect(stat(join(layout.packbatHome, "cloud-credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
		const after = JSON.parse(await readFile(join(layout.packbatHome, "config.json"), "utf8")) as {
			offbox: { remotes: Array<{ type: string }> };
		};
		expect(after.offbox.remotes.map(({ type }) => type)).toEqual(["rclone"]);
	});
});
