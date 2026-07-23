import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { encryptToRecipient } from "../src/offbox/age.js";
import { generateTestIdentity } from "./helpers/age.js";
import { makeClaudeStore } from "./helpers/fixtures.js";
import { enter, makeTempHome, runCli, runInteractiveCli } from "./helpers/run-cli.js";

const homes: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const cliPackageVersion = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
	return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

function reject(response: ServerResponse): void {
	json(response, 409, { error: "invalid_test_request" });
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse, baseUrl: string) => Promise<void>,
): Promise<string> {
	let baseUrl = "";
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", baseUrl);
		if (url.pathname.startsWith("/v1/") && request.headers["x-packbat-cli-version"] !== cliPackageVersion) {
			reject(response);
			return;
		}
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

// openUrl spawns `open` on darwin and `xdg-open` elsewhere; stub both so the
// suite behaves identically on every platform CI runs.
async function stubOpener(dir: string, script: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	for (const name of ["open", "xdg-open"]) {
		const path = join(dir, name);
		await writeFile(path, script, { mode: 0o700 });
		await chmod(path, 0o700);
	}
	return dir;
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
			PACKBAT_CLOUD: "1",
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
	test("cloud commands refuse while Packbat Cloud is disabled", async () => {
		const layout = await cloudLayout();
		const { PACKBAT_CLOUD: _enabled, ...env } = layout.env;

		const result = await runCli(["cloud", "link"], { home: layout.home, env });

		expect(result).toEqual({
			code: 1,
			stdout: "",
			stderr: "Packbat Cloud is not available. Off-box copies go to a remote you own, run `packbat init`.\n",
		});
	});

	test("the wizard does not offer Packbat Cloud as a destination", async () => {
		const layout = await cloudLayout();

		const result = await runInteractiveCli(["init", "--no-activate"], { home: layout.home, env: layout.env }, [
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Skip for now", reply: String.fromCharCode(3) },
		]);

		expect(result.code).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("Setup cancelled.");
		expect(`${result.stdout}${result.stderr}`).not.toContain("Packbat Cloud");
	});

	test("uploads the backfill concurrently and never re-uploads checkpointed objects after a failure", async () => {
		const layout = await cloudLayout();
		const { recipient } = await generateTestIdentity();
		const machineRemoteId = "abcdefghijklmnopqrstuvwx";
		await writeCredentials(layout.packbatHome);
		for (let index = 0; index < 12; index += 1) {
			await makeClaudeStore(layout.claudeRoot, {
				id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
				encodedCwd: "-synthetic-project",
			});
		}
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

		const putCounts = new Map<string, number>();
		const reservationsById = new Map<string, string>();
		let acceptedData = 0;
		let inflight = 0;
		let peakInflight = 0;
		let failAfter = 5;
		let injectRateLimit = false;
		let rateLimitedServed = 0;
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/downloads") {
				json(response, 404, { error: "object_not_found" });
				return;
			}
			if (url.pathname === "/v1/machines" && request.method === "GET") {
				json(response, 200, {
					machines: [{ createdAt: "2026-07-18T00:00:00.000Z", id: "emptyRegistration0000000" }],
				});
				return;
			}
			if (url.pathname === "/v1/uploads/reservations") {
				const input = JSON.parse((await body(request)).toString("utf8")) as { logicalObjectKey: string };
				const key = input.logicalObjectKey;
				if (key !== "index.jsonl.age") {
					if (injectRateLimit) {
						injectRateLimit = false;
						rateLimitedServed += 1;
						json(response, 429, { error: "rate_limited" });
						return;
					}
					if (acceptedData >= failAfter) {
						reject(response);
						return;
					}
					acceptedData += 1;
					inflight += 1;
					peakInflight = Math.max(peakInflight, inflight);
				}
				const id = randomUUID();
				reservationsById.set(id, key);
				json(response, 201, {
					reservationId: id,
					state: "pending",
					upload: {
						expiresAt: "2099-01-01T00:00:00.000Z",
						headers: { "Content-Type": "application/octet-stream" },
						url: `${origin}/uploads/${id}`,
					},
				});
				return;
			}
			if (url.pathname.startsWith("/uploads/") && request.method === "PUT") {
				const key = reservationsById.get(url.pathname.slice("/uploads/".length));
				if (key === undefined) throw new Error("unknown reservation");
				await body(request);
				putCounts.set(key, (putCounts.get(key) ?? 0) + 1);
				response.writeHead(200);
				response.end();
				return;
			}
			if (url.pathname.match(/^\/v1\/uploads\/[^/]+\/finalize$/u)) {
				const key = reservationsById.get(url.pathname.split("/").at(-2) ?? "");
				if (key === undefined) throw new Error("unknown reservation");
				if (key !== "index.jsonl.age") inflight -= 1;
				json(response, 200, { etag: `etag-${putCounts.size}` });
				return;
			}
			reject(response);
		});
		const env = { ...layout.env, PACKBAT_CLOUD_API_URL: baseUrl };

		const first = await runCli(["sync"], { home: layout.home, env });
		expect(first.code, `${first.stdout}${first.stderr}`).toBe(1);
		expect(`${first.stdout}${first.stderr}`).toContain("off-box");
		const offboxState = join(layout.packbatHome, "state", "offbox");
		const [stateHash] = await readdir(offboxState);
		const uploadedPath = join(offboxState, stateHash ?? "", "uploaded.jsonl");
		const checkpointedLines = (await readFile(uploadedPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
		expect(checkpointedLines.length).toBe(5);

		failAfter = Number.POSITIVE_INFINITY;
		injectRateLimit = true;
		const second = await runCli(["sync"], { home: layout.home, env });
		expect(second.code, `${second.stdout}${second.stderr}`).toBe(0);
		expect(rateLimitedServed).toBe(1);
		expect(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`).not.toContain("does not exist");
		expect(peakInflight).toBeGreaterThanOrEqual(2);
		const dataKeys = [...putCounts.keys()].filter((key) => key !== "index.jsonl.age");
		expect(dataKeys.length).toBeGreaterThan(5);
		for (const [key, count] of putCounts) {
			expect(count, `object ${key} uploaded ${count} times`).toBe(1);
		}
		const finalLines = (await readFile(uploadedPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
		expect(finalLines.length).toBe(dataKeys.length);
	}, 60_000);

	test("mirror skips a machine whose index is encrypted to a different key", async () => {
		const layout = await cloudLayout();
		await writeCredentials(layout.packbatHome);
		const mine = await generateTestIdentity();
		const other = await generateTestIdentity();
		const machineRemoteId = "abcdefghijklmnopqrstuvwx";
		const foreignId = "foreignKeyMachine0000000";
		await writeFile(join(layout.packbatHome, "identity.txt"), `${mine.identity}\n`);
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "cloud-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: { mode: "configured", recipient: mine.recipient, remotes: [{ type: "cloud", machineRemoteId }] },
			})}\n`,
		);
		const foreignIndex = await encryptToRecipient(other.recipient, Buffer.from("", "utf8"));
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/machines" && request.method === "GET") {
				json(response, 200, { machines: [{ createdAt: "2026-07-18T00:00:00.000Z", id: foreignId }] });
				return;
			}
			if (url.pathname === "/v1/downloads") {
				const input = JSON.parse((await body(request)).toString("utf8")) as { machineRemoteId: string };
				if (input.machineRemoteId === foreignId) {
					json(response, 200, { expiresAt: "2099-01-01T00:00:00.000Z", url: `${origin}/objects/foreign-index` });
					return;
				}
				json(response, 404, { error: "object_not_found" });
				return;
			}
			if (url.pathname === "/objects/foreign-index") {
				response.writeHead(200);
				response.end(foreignIndex);
				return;
			}
			if (url.pathname === "/v1/uploads/reservations") {
				await body(request);
				const id = randomUUID();
				json(response, 201, {
					reservationId: id,
					state: "pending",
					upload: {
						expiresAt: "2099-01-01T00:00:00.000Z",
						headers: { "Content-Type": "application/octet-stream" },
						url: `${origin}/uploads/${id}`,
					},
				});
				return;
			}
			if (url.pathname.startsWith("/uploads/") && request.method === "PUT") {
				await body(request);
				response.writeHead(200);
				response.end();
				return;
			}
			if (url.pathname.match(/^\/v1\/uploads\/[^/]+\/finalize$/u)) {
				json(response, 200, { etag: "etag-1" });
				return;
			}
			reject(response);
		});

		const result = await runCli(["sync"], {
			home: layout.home,
			env: { ...layout.env, PACKBAT_CLOUD_API_URL: baseUrl },
		});
		const output = `${result.stdout}${result.stderr}`;
		expect(result.code, output).toBe(0);
		expect(output).not.toContain("no identity matched");
		expect(await readFile(join(layout.packbatHome, "logs", "packbat.log"), "utf8")).toContain(
			`mirror skipped ${foreignId}: its index is encrypted to a different key`,
		);
	}, 60_000);

	test("backfills through exact-object uploads, commits the index last, and reports entitlement state", async () => {
		const layout = await cloudLayout();
		const { identity, recipient } = await generateTestIdentity();
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
		let acceptsReservations = true;
		let archiveReservationCount = 0;
		let finalizedArchiveCount = 0;
		let reservationSweepId: string | undefined;
		let indexReserved = false;
		let billingState: "active" | "grace" = "active";
		let advertisesUpdate = true;
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (advertisesUpdate && url.pathname.startsWith("/v1/")) {
				response.setHeader("x-packbat-cli-update", "9.9.9");
			}
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
				const logicalObjectKey = String(input.logicalObjectKey);
				const sweepId = String(input.sweepId);
				reservationSweepId ??= sweepId;
				if (
					!acceptsReservations ||
					indexReserved ||
					sweepId !== reservationSweepId ||
					logicalObjectKey.includes("cloud-machine/") ||
					(logicalObjectKey === "index.jsonl.age"
						? input.expectedArchiveCount !== archiveReservationCount ||
							input.expectedIndexEtag !== null ||
							finalizedArchiveCount !== archiveReservationCount
						: !logicalObjectKey.startsWith("claude-code/"))
				) {
					reject(response);
					return;
				}
				if (logicalObjectKey === "index.jsonl.age") {
					indexReserved = true;
				} else {
					archiveReservationCount += 1;
				}
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
				const logicalObjectKey = String(reservation.logicalObjectKey);
				const object = await body(request);
				if (object.byteLength !== reservation.expectedBytes) {
					reject(response);
					return;
				}
				objects.set(logicalObjectKey, object);
				response.writeHead(200);
				response.end();
				return;
			}
			if (url.pathname.match(/^\/v1\/uploads\/[^/]+\/finalize$/u)) {
				const id = url.pathname.split("/").at(-2);
				const reservation = id === undefined ? undefined : reservationsById.get(id);
				const logicalObjectKey = String(reservation?.logicalObjectKey);
				if (reservation === undefined || !objects.has(logicalObjectKey)) {
					reject(response);
					return;
				}
				if (logicalObjectKey !== "index.jsonl.age") {
					finalizedArchiveCount += 1;
				}
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
		expect(
			first.stdout
				.split("\n")
				.filter((line) => line === "packbat 9.9.9 is available, update with npm install --global packbat@latest"),
		).toHaveLength(1);
		advertisesUpdate = false;
		const [remoteStateName] = await readdir(join(layout.packbatHome, "state", "offbox"));
		if (remoteStateName === undefined) throw new Error("Packbat did not create remote state");
		const remoteStatePath = join(layout.packbatHome, "state", "offbox", remoteStateName);
		const uploadedBefore = await readFile(join(remoteStatePath, "uploaded.jsonl"), "utf8");
		expect(uploadedBefore).toContain(fixture.files[0]!.relPath);
		expect(JSON.parse(await readFile(join(remoteStatePath, "cloud.json"), "utf8"))).toEqual({
			v: 1,
			currentIndexEtag: expect.any(String),
		});

		acceptsReservations = false;
		const second = await runCli(["sync"], { home: layout.home, env });
		expect(second.code, second.stderr).toBe(0);
		expect(second.stdout).not.toContain(" is available, update with npm install --global packbat@latest");
		expect(await readFile(join(remoteStatePath, "uploaded.jsonl"), "utf8")).toBe(uploadedBefore);

		const restoreLayout = await cloudLayout();
		await writeCredentials(restoreLayout.packbatHome);
		const identityPath = join(restoreLayout.home, "recovery-kit.txt");
		await writeFile(
			identityPath,
			`Packbat recovery kit

Age identity
${identity}

Age recipient
${recipient}

Remote
type: cloud
destination: Packbat Cloud
machine remote: ${machineRemoteId}
`,
			{ mode: 0o600 },
		);
		const restoreEnv = { ...restoreLayout.env, PACKBAT_CLOUD_API_URL: baseUrl };
		const restoreLink = await runCli(["cloud", "link", "--restore-from", identityPath], {
			home: restoreLayout.home,
			env: restoreEnv,
		});
		expect(restoreLink.code, restoreLink.stderr).toBe(0);
		expect(restoreLink.stdout).toContain("restore access linked from the recovery kit");
		const restoreConfig = JSON.parse(await readFile(join(restoreLayout.packbatHome, "config.json"), "utf8")) as {
			offbox: { recipient: string; remotes: Array<Record<string, unknown>> };
		};
		expect(restoreConfig.offbox).toMatchObject({
			recipient,
			remotes: [{ type: "cloud", machineRemoteId }],
		});
		const listed = await runCli(
			["restore", "--from-remote", "--identity", identityPath, "--machine", "cloud-machine"],
			{
				home: restoreLayout.home,
				env: restoreEnv,
			},
		);
		expect(listed.code, listed.stderr).toBe(0);
		expect(listed.stdout, listed.stderr).toContain(fixture.id);
		const restored = await runCli(
			["restore", "--from-remote", "--identity", identityPath, "--machine", "cloud-machine", fixture.id],
			{ home: restoreLayout.home, env: restoreEnv },
		);
		expect(restored.code, restored.stderr).toBe(0);
		expect(await readFile(join(restoreLayout.claudeRoot, fixture.files[0]!.relPath))).toEqual(sourceBytes);

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

	test("reports when Packbat Cloud requires a newer CLI", async () => {
		const layout = await cloudLayout();
		const { recipient } = await generateTestIdentity();
		await Promise.all([makeClaudeStore(layout.claudeRoot), writeCredentials(layout.packbatHome)]);
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "outdated-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: {
					mode: "configured",
					recipient,
					remotes: [{ type: "cloud", machineRemoteId: "abcdefghijklmnopqrstuvwx" }],
				},
			})}\n`,
		);
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/uploads/reservations") {
				json(response, 426, { error: "cli_outdated" });
				return;
			}
			json(response, 404, { error: "not_found" });
		});

		const result = await runCli(["sync"], {
			home: layout.home,
			env: { ...layout.env, PACKBAT_CLOUD_API_URL: baseUrl },
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Packbat Cloud needs a newer packbat, update with npm install --global packbat@latest",
		);
	});

	test("refreshes an expired access token through the versioned API path", async () => {
		const layout = await cloudLayout();
		const { recipient } = await generateTestIdentity();
		await mkdir(layout.packbatHome, { recursive: true });
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "refresh-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: {
					mode: "configured",
					recipient,
					remotes: [{ type: "cloud", machineRemoteId: "abcdefghijklmnopqrstuvwx" }],
				},
			})}\n`,
		);
		const credentialsPath = join(layout.packbatHome, "cloud-credentials.json");
		await writeFile(
			credentialsPath,
			`${JSON.stringify({
				v: 1,
				accessToken: "stale-access-token",
				accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
				checkoutIdempotencyKey: "refresh-link",
				refreshToken: "live-refresh-token",
				refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
			})}\n`,
			{ mode: 0o600 },
		);
		const binPath = await stubOpener(join(layout.home, "bin-refresh"), "#!/bin/sh\nexit 0\n");
		let refreshed = false;
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/auth/refresh") {
				const payload = JSON.parse((await body(request)).toString("utf8")) as { refreshToken: string };
				expect(payload.refreshToken).toBe("live-refresh-token");
				refreshed = true;
				json(response, 200, {
					accessToken: "rotated-access-token",
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
					refreshToken: "rotated-refresh-token",
					refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
					tokenType: "Bearer",
				});
				return;
			}
			if (url.pathname === "/v1/billing/portal") {
				json(response, 200, { url: `${origin}/portal` });
				return;
			}
			json(response, 404, { error: "not_found" });
		});

		const result = await runCli(["cloud", "billing"], {
			home: layout.home,
			env: {
				...layout.env,
				PACKBAT_CLOUD_API_URL: baseUrl,
				PATH: `${binPath}:${process.env.PATH ?? ""}`,
			},
		});

		expect(result.code, result.stderr).toBe(0);
		expect(refreshed).toBe(true);
		expect(await readFile(credentialsPath, "utf8")).toContain("rotated-refresh-token");
	});

	test("links from GitHub Device Flow without persisting the provider token", async () => {
		const layout = await cloudLayout();
		const { recipient } = await generateTestIdentity();
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
		const binPath = await stubOpener(
			join(layout.home, "device-bin"),
			`#!/bin/sh\nprintf '%s\\n' "$1" >> "${openedPath}"\n`,
		);
		const githubToken = "github-token-must-not-persist";
		const expectedPaths = [
			"/v1/client",
			"/github/device",
			"/github/token",
			"/v1/auth/github/exchange",
			"/v1/billing/status",
			"/v1/machines",
		];
		let expectedPathIndex = 0;
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname !== expectedPaths[expectedPathIndex]) {
				reject(response);
				return;
			}
			expectedPathIndex += 1;
			if (url.pathname === "/v1/client") {
				json(response, 200, { githubClientId: "Ov23liPackbatDeviceTest" });
				return;
			}
			if (url.pathname === "/github/device") {
				const input = new URLSearchParams((await body(request)).toString("utf8"));
				if (input.get("client_id") !== "Ov23liPackbatDeviceTest" || input.has("scope")) {
					reject(response);
					return;
				}
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
				if (input.get("client_secret") !== null) {
					reject(response);
					return;
				}
				json(response, 200, { access_token: githubToken });
				return;
			}
			if (url.pathname === "/v1/auth/github/exchange") {
				const input = JSON.parse((await body(request)).toString("utf8")) as Record<string, unknown>;
				if (Object.keys(input).length !== 1 || input.githubAccessToken !== githubToken) {
					reject(response);
					return;
				}
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
		expect(result.stdout).toContain("machine remote: abcdefghijklmnopqrstuvwx");
		const credentialsPath = join(layout.packbatHome, "cloud-credentials.json");
		const credentials = await readFile(credentialsPath, "utf8");
		expect(credentials).not.toContain(githubToken);
		expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
		expect(await readFile(join(layout.packbatHome, "config.json"), "utf8")).toContain(
			'"machineRemoteId": "abcdefghijklmnopqrstuvwx"',
		);
		expect(await readFile(openedPath, "utf8")).toContain(`${baseUrl}/github/verify`);
	});

	test("expired credentials relink through Device Flow and do not wedge unlink", async () => {
		const layout = await cloudLayout();
		const { recipient } = await generateTestIdentity();
		const machineRemoteId = "abcdefghijklmnopqrstuvwx";
		await mkdir(layout.packbatHome, { recursive: true });
		await writeFile(
			join(layout.packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "expired-machine",
				archiveRoot: layout.archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: { mode: "configured", recipient, remotes: [{ type: "cloud", machineRemoteId }] },
			})}\n`,
		);
		const expiredCredentials = `${JSON.stringify({
			v: 1,
			accessToken: "expired-access-token",
			accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
			checkoutIdempotencyKey: "expired-link",
			refreshToken: "expired-refresh-token",
			refreshTokenExpiresAt: "2000-01-02T00:00:00.000Z",
		})}\n`;
		const credentialsPath = join(layout.packbatHome, "cloud-credentials.json");
		await writeFile(credentialsPath, expiredCredentials, { mode: 0o600 });
		const binPath = await stubOpener(join(layout.home, "bin-expired"), "#!/bin/sh\nexit 0\n");
		const githubToken = "github-relink-token";
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/client") {
				json(response, 200, { githubClientId: "Ov23liPackbatRelinkTest" });
				return;
			}
			if (url.pathname === "/github/device") {
				json(response, 200, {
					device_code: "synthetic-device-code",
					expires_in: 600,
					interval: 1,
					user_code: "RELINK-ME",
					verification_uri: `${origin}/github/verify`,
				});
				return;
			}
			if (url.pathname === "/github/token") {
				json(response, 200, { access_token: githubToken });
				return;
			}
			if (url.pathname === "/v1/auth/github/exchange") {
				json(response, 200, {
					accessToken: "replacement-access-token",
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
					refreshToken: "replacement-refresh-token",
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
			json(response, 404, { error: "not_found" });
		});
		const env = {
			...layout.env,
			PACKBAT_CLOUD_API_URL: baseUrl,
			PACKBAT_GITHUB_ACCESS_TOKEN_URL: `${baseUrl}/github/token`,
			PACKBAT_GITHUB_DEVICE_CODE_URL: `${baseUrl}/github/device`,
			PATH: `${binPath}:${process.env.PATH ?? ""}`,
		};
		const relinked = await runCli(["cloud", "link"], { home: layout.home, env });
		expect(relinked.code, relinked.stderr).toBe(0);
		expect(relinked.stdout).toContain("GitHub code: RELINK-ME");
		expect(relinked.stdout).toContain("Packbat Cloud is already linked");
		expect(await readFile(credentialsPath, "utf8")).toContain("replacement-refresh-token");

		await writeFile(credentialsPath, expiredCredentials, { mode: 0o600 });
		const unlinked = await runCli(["cloud", "unlink"], { home: layout.home, env });
		expect(unlinked.code, unlinked.stderr).toBe(0);
		await expect(stat(credentialsPath)).rejects.toMatchObject({ code: "ENOENT" });
		const config = JSON.parse(await readFile(join(layout.packbatHome, "config.json"), "utf8")) as {
			offbox: { mode: string };
		};
		expect(config.offbox.mode).toBe("skipped");
	});

	test("link completes Checkout before registering the remote, opens billing, and unlinks locally and remotely", async () => {
		const layout = await cloudLayout();
		const { recipient } = await generateTestIdentity();
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
		const binPath = await stubOpener(join(layout.home, "bin"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${openedPath}"\n`);

		let checkoutStarted = false;
		let stage: "checkout" | "machine" | "portal" | "revoke" | "status-after-checkout" | "status-before-checkout" =
			"status-before-checkout";
		const machineRemoteId = "zyxwvutsrqponmlkjihgfedc";
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/billing/status") {
				if (stage === "status-before-checkout") {
					stage = "checkout";
				} else if (stage === "status-after-checkout") {
					stage = "machine";
				} else {
					reject(response);
					return;
				}
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
				if (stage !== "checkout") {
					reject(response);
					return;
				}
				stage = "status-after-checkout";
				checkoutStarted = true;
				json(response, 201, { url: `${origin}/hosted-checkout` });
				return;
			}
			if (url.pathname === "/v1/machines") {
				if (stage !== "machine") {
					reject(response);
					return;
				}
				stage = "portal";
				json(response, 201, { id: machineRemoteId });
				return;
			}
			if (url.pathname === "/v1/billing/portal") {
				if (stage !== "portal") {
					reject(response);
					return;
				}
				stage = "revoke";
				json(response, 200, { url: `${origin}/hosted-portal` });
				return;
			}
			if (url.pathname === "/v1/auth/credential" && request.method === "DELETE") {
				if (stage !== "revoke") {
					reject(response);
					return;
				}
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
		expect(linked.stdout).toContain(`machine remote: ${machineRemoteId}`);
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
		expect((await stat(join(layout.packbatHome, "config.json"))).mode & 0o777).toBeGreaterThan(0);
		await expect(stat(join(layout.packbatHome, "cloud-credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
		const after = JSON.parse(await readFile(join(layout.packbatHome, "config.json"), "utf8")) as {
			offbox: { remotes: Array<{ type: string }> };
		};
		expect(after.offbox.remotes.map(({ type }) => type)).toEqual(["rclone"]);
	});

	test("mirrors a foreign Cloud machine under its index name and does not pull its archive twice", async () => {
		const layout = await cloudLayout();
		const { identity, recipient } = await generateTestIdentity();
		const ownMachineRemoteId = "abcdefghijklmnopqrstuvwx";
		const foreignMachineRemoteId = "ZYXWVUTSRQPONMLKJIHGFEDC";
		const foreignMachine = "foreign-cloud-machine";
		const fixture = await makeClaudeStore(join(layout.home, "foreign-store"), { sidecars: [] });
		const source = await readFile(fixture.files[0]!.absPath);
		const archive = zstdCompressSync(source);
		const archivePath = `claude-code/${fixture.id}.jsonl.zst`;
		const indexFor = (raw: Buffer, stored: Buffer, sourceMtimeMs: number): Buffer =>
			Buffer.from(
				`${JSON.stringify({
					v: 1,
					path: archivePath,
					harness: "claude-code",
					machine: foreignMachine,
					unit: fixture.id,
					role: "main",
					source: "/synthetic/foreign-session.jsonl",
					sourceMtimeMs,
					sourceSize: raw.byteLength,
					storedSize: stored.byteLength,
					sha256: createHash("sha256").update(stored).digest("hex"),
					archivedAt: "2026-01-02T03:04:05.000Z",
				})}\n`,
			);
		const initialMtimeMs = 1_767_322_645_000;
		const objects = new Map<string, Buffer>([
			[
				`${foreignMachineRemoteId}/index.jsonl.age`,
				Buffer.from(await encryptToRecipient(recipient, indexFor(source, archive, initialMtimeMs))),
			],
			[`${foreignMachineRemoteId}/${archivePath}.age`, Buffer.from(await encryptToRecipient(recipient, archive))],
		]);
		await mkdir(layout.packbatHome, { recursive: true });
		await Promise.all([
			writeCredentials(layout.packbatHome),
			writeFile(join(layout.packbatHome, "identity.txt"), `${identity}\n`, { mode: 0o600 }),
			writeFile(
				join(layout.packbatHome, "config.json"),
				`${JSON.stringify({
					version: 2,
					machine: "cloud-machine",
					archiveRoot: layout.archiveRoot,
					sweep: { intervalMinutes: 60 },
					offbox: {
						mode: "configured",
						recipient,
						remotes: [{ type: "cloud", machineRemoteId: ownMachineRemoteId }],
					},
				})}\n`,
			),
		]);

		const reservations = new Map<string, { key: string; machineRemoteId: string }>();
		let foreignArchiveDownloads = 0;
		let listForeignArchive = true;
		const baseUrl = await listen(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/v1/machines" && request.method === "GET") {
				json(response, 200, {
					machines: [
						{ id: ownMachineRemoteId, createdAt: "2026-01-01T00:00:00.000Z" },
						{ id: foreignMachineRemoteId, createdAt: "2026-01-02T00:00:00.000Z" },
					],
				});
				return;
			}
			if (url.pathname === `/v1/machines/${foreignMachineRemoteId}/objects`) {
				if (url.searchParams.get("cursor") === null) {
					json(response, 200, {
						objects: [
							{ key: "index.jsonl.age", size: objects.get(`${foreignMachineRemoteId}/index.jsonl.age`)!.byteLength },
						],
						cursor: "index.jsonl.age",
					});
				} else {
					json(response, 200, {
						objects: listForeignArchive
							? [
									{
										key: `${archivePath}.age`,
										size: objects.get(`${foreignMachineRemoteId}/${archivePath}.age`)!.byteLength,
									},
								]
							: [],
					});
				}
				return;
			}
			if (url.pathname === "/v1/downloads") {
				const input = JSON.parse((await body(request)).toString("utf8")) as {
					logicalObjectKey: string;
					machineRemoteId: string;
				};
				const objectKey = `${input.machineRemoteId}/${input.logicalObjectKey}`;
				if (!objects.has(objectKey)) {
					json(response, 404, { error: "object_not_found" });
					return;
				}
				json(response, 200, {
					expiresAt: "2099-01-01T00:00:00.000Z",
					url: `${origin}/objects/${Buffer.from(objectKey).toString("base64url")}`,
				});
				return;
			}
			if (url.pathname === "/v1/uploads/reservations") {
				const input = JSON.parse((await body(request)).toString("utf8")) as {
					logicalObjectKey: string;
					machineRemoteId: string;
				};
				const id = randomUUID();
				reservations.set(id, { key: input.logicalObjectKey, machineRemoteId: input.machineRemoteId });
				json(response, 201, {
					reservationId: id,
					state: "pending",
					upload: {
						expiresAt: "2099-01-01T00:00:00.000Z",
						headers: { "Content-Type": "application/octet-stream" },
						url: `${origin}/uploads/${id}`,
					},
				});
				return;
			}
			if (url.pathname.startsWith("/uploads/") && request.method === "PUT") {
				const id = url.pathname.slice("/uploads/".length);
				const reservation = reservations.get(id);
				if (reservation === undefined) throw new Error("unknown upload reservation");
				objects.set(`${reservation.machineRemoteId}/${reservation.key}`, await body(request));
				response.writeHead(200);
				response.end();
				return;
			}
			if (url.pathname.match(/^\/v1\/uploads\/[^/]+\/finalize$/u)) {
				json(response, 200, { etag: `etag-${reservations.size}` });
				return;
			}
			if (url.pathname.startsWith("/objects/")) {
				const objectKey = Buffer.from(url.pathname.slice("/objects/".length), "base64url").toString("utf8");
				if (objectKey === `${foreignMachineRemoteId}/${archivePath}.age`) {
					foreignArchiveDownloads += 1;
				}
				response.writeHead(200, { "Content-Type": "application/octet-stream" });
				response.end(objects.get(objectKey));
				return;
			}
			json(response, 404, { error: "not_found" });
		});
		const env = { ...layout.env, PACKBAT_CLOUD_API_URL: baseUrl };

		const first = await runCli(["sync"], { home: layout.home, env });
		expect(first.code, first.stderr).toBe(0);
		expect(first.stdout).toContain("mirrored 1");
		expect(await readFile(join(layout.archiveRoot, foreignMachine, archivePath))).toEqual(archive);
		const searched = await runCli(["search", "fixture prompt"], { home: layout.home, env });
		expect(searched.code, searched.stderr).toBe(0);
		expect(searched.stdout).toContain("Synthetic fixture prompt.");

		const second = await runCli(["sync"], { home: layout.home, env });
		expect(second.code, second.stderr).toBe(0);
		expect(second.stdout).not.toContain("mirrored");
		expect(foreignArchiveDownloads).toBe(1);

		const restampedMtimeMs = initialMtimeMs + 60_000;
		objects.set(
			`${foreignMachineRemoteId}/index.jsonl.age`,
			Buffer.from(await encryptToRecipient(recipient, indexFor(source, archive, restampedMtimeMs))),
		);
		const restamped = await runCli(["sync"], { home: layout.home, env });
		expect(restamped.code, restamped.stderr).toBe(0);
		expect(restamped.stdout).not.toContain("mirrored");
		expect(foreignArchiveDownloads).toBe(1);
		expect((await stat(join(layout.archiveRoot, foreignMachine, archivePath))).mtimeMs).toBe(restampedMtimeMs);

		const changedSource = Buffer.from(
			`${source.toString("utf8")}${JSON.stringify({
				type: "user",
				uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				parentUuid: null,
				sessionId: fixture.id,
				timestamp: "2026-01-02T03:06:05.000Z",
				cwd: "/synthetic/project",
				message: { role: "user", content: "Foreign growth sentinel." },
			})}\n`,
		);
		const changedArchive = zstdCompressSync(changedSource);
		const changedMtimeMs = restampedMtimeMs + 60_000;
		objects.set(
			`${foreignMachineRemoteId}/${archivePath}.age`,
			Buffer.from(await encryptToRecipient(recipient, changedArchive)),
		);
		objects.set(
			`${foreignMachineRemoteId}/index.jsonl.age`,
			Buffer.from(await encryptToRecipient(recipient, indexFor(changedSource, changedArchive, changedMtimeMs))),
		);

		const refreshed = await runCli(["sync"], { home: layout.home, env });
		expect(refreshed.code, refreshed.stderr).toBe(0);
		expect(refreshed.stdout).toContain("mirrored 1");
		expect(foreignArchiveDownloads).toBe(2);
		expect(await readFile(join(layout.archiveRoot, foreignMachine, archivePath))).toEqual(changedArchive);

		const restored = await runCli(["restore", "--machine", foreignMachine, fixture.id], {
			home: layout.home,
			env,
		});
		expect(restored.code, restored.stderr).toBe(0);
		expect(await readFile(join(layout.claudeRoot, `${fixture.id}.jsonl`))).toEqual(changedSource);

		const localIndexPath = join(layout.archiveRoot, foreignMachine, "index.jsonl");
		const installedIndex = await readFile(localIndexPath);
		objects.set(
			`${foreignMachineRemoteId}/index.jsonl.age`,
			Buffer.from(
				await encryptToRecipient(recipient, indexFor(changedSource, changedArchive, changedMtimeMs + 60_000)),
			),
		);
		listForeignArchive = false;
		const incomplete = await runCli(["sync"], { home: layout.home, env });
		expect(incomplete.code).toBe(0);
		expect(incomplete.stderr).toContain(
			`${foreignMachine}/${archivePath}: indexed object is missing from remote listing`,
		);
		expect(await readFile(localIndexPath)).toEqual(installedIndex);
	});
});
