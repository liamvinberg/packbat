import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { renderRecoveryKit } from "../src/offbox/recovery-kit.js";
import { deriveTestRecipient, generateTestIdentity } from "./helpers/age.js";
import {
	acquireOAuthCallbackPort,
	backspaces,
	enter,
	type InteractiveStep,
	makeTempHome,
	moveDown,
	moveUp,
	runInteractiveCli,
} from "./helpers/run-cli.js";

const homes: string[] = [];

afterEach(async () => {
	await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })));
});

function finishSteps(): InteractiveStep[] {
	return [
		{ waitFor: "Encryption key", reply: enter() },
		{ waitFor: "Recovery kit destination", reply: enter() },
		{ waitFor: "Recovery kit path", reply: enter() },
	];
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") reject(new Error("provider fake did not bind"));
			else resolve(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

async function fetchRedirect(home: string, source: string, destination: string): Promise<Record<string, string>> {
	const hookPath = join(home, "fetch-redirect.mjs");
	await writeFile(
		hookPath,
		`const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return originalFetch(url === ${JSON.stringify(source)} ? ${JSON.stringify(destination)} : input, init);
};
`,
		{ mode: 0o600 },
	);
	return { NODE_OPTIONS: `--import=${hookPath}` };
}

async function dropboxBoundary(home: string): Promise<{ env: Record<string, string>; server: Server }> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({
				access_token: "dropbox-access-token",
				expires_in: 14_400,
				refresh_token: "dropbox-refresh-token",
				token_type: "bearer",
			}),
		);
	});
	const port = await listen(server);
	const binPath = join(home, "bin");
	await mkdir(binPath, { recursive: true });
	const browserScript = `#!/usr/bin/env node
const source = new URL(process.argv[2]);
const callback = new URL(source.searchParams.get("redirect_uri"));
callback.search = new URLSearchParams({ code: "synthetic-code", state: source.searchParams.get("state") }).toString();
fetch(callback).catch(() => { process.exitCode = 1; });
`;
	for (const name of ["open", "xdg-open"]) {
		const path = join(binPath, name);
		await writeFile(path, browserScript, { mode: 0o700 });
		await chmod(path, 0o700);
	}
	return {
		server,
		env: {
			...(await fetchRedirect(home, "https://api.dropboxapi.com/oauth2/token", `http://127.0.0.1:${port}/token`)),
			PACKBAT_DROPBOX_APP_KEY: "synthetic-app-key",
			PATH: `${binPath}${delimiter}${process.env.PATH ?? ""}`,
		},
	};
}

async function googleRcloneBoundary(home: string): Promise<Record<string, string>> {
	const binPath = join(home, "bin");
	const wrapperPath = join(binPath, "rclone");
	const realRclone = execFileSync("sh", ["-c", "command -v rclone"], { encoding: "utf8" }).trim();
	await mkdir(binPath, { recursive: true });
	await writeFile(
		wrapperPath,
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
const env = { ...process.env };
if (process.argv[2] === "config") delete env.RCLONE_CONFIG_PACKBAT_TYPE;
const child = spawn(process.env.PACKBAT_TEST_REAL_RCLONE, process.argv.slice(2), { env, stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("close", (code) => { process.exitCode = code ?? 1; });
`,
		{ mode: 0o700 },
	);
	await chmod(wrapperPath, 0o700);
	return {
		PACKBAT_TEST_REAL_RCLONE: realRclone,
		PATH: `${binPath}${delimiter}${process.env.PATH ?? ""}`,
	};
}

async function googleBrowserBoundary(home: string): Promise<{ env: Record<string, string>; server: Server }> {
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/authorize") {
			const redirectUri = requestUrl.searchParams.get("redirect_uri");
			const state = requestUrl.searchParams.get("state");
			if (redirectUri === null || state === null) {
				response.writeHead(400).end();
				return;
			}
			const callback = new URL(redirectUri);
			callback.search = new URLSearchParams({ code: "google-code", state }).toString();
			response.writeHead(302, { Location: callback.toString() }).end();
			return;
		}
		if (requestUrl.pathname === "/token") {
			response.writeHead(200, { "Content-Type": "application/json" }).end(
				JSON.stringify({
					access_token: "google-browser-access-token",
					expires_in: 3600,
					refresh_token: "google-browser-refresh-token",
					token_type: "Bearer",
				}),
			);
			return;
		}
		response.writeHead(404).end();
	});
	const port = await listen(server);
	const binPath = join(home, "bin");
	await mkdir(binPath, { recursive: true });
	const browserScript = `#!/usr/bin/env node
fetch(process.argv[2]).catch(() => { process.exitCode = 1; });
`;
	for (const name of ["open", "xdg-open"]) {
		const path = join(binPath, name);
		await writeFile(path, browserScript, { mode: 0o700 });
		await chmod(path, 0o700);
	}
	return {
		server,
		env: {
			...(await googleRcloneBoundary(home)),
			PACKBAT_GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
			PACKBAT_GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
			RCLONE_DRIVE_AUTH_URL: `http://127.0.0.1:${port}/authorize`,
			RCLONE_DRIVE_TOKEN_URL: `http://127.0.0.1:${port}/token`,
		},
	};
}

async function runManagedLane(options: {
	home: string;
	steps: InteractiveStep[];
	env?: Record<string, string>;
}): Promise<{ config: string; kit: string; output: string }> {
	const packbatHome = join(options.home, ".packbat");
	const kitPath = join(options.home, "packbat-recovery-kit.txt");
	const result = await runInteractiveCli(
		["init", "--no-activate"],
		{
			home: options.home,
			env: {
				PACKBAT_HOME: packbatHome,
				RCLONE_CONFIG_PACKBAT_TYPE: "local",
				...options.env,
			},
		},
		[
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			...options.steps,
			...finishSteps(),
		],
	);
	const output = `${result.stdout}${result.stderr}`;
	expect(result.code, output).toBe(0);
	return {
		config: await readFile(join(packbatHome, "rclone.conf"), "utf8"),
		kit: await readFile(kitPath, "utf8"),
		output,
	};
}

describe.sequential("interactive init wizard", () => {
	test.each([
		{
			name: "Cloudflare R2",
			steps: [
				{ waitFor: "Off-box destination", reply: moveUp(2) },
				{ waitFor: "S3 provider", reply: enter() },
				{ waitFor: "Cloudflare account ID", reply: enter("0123456789abcdef0123456789abcdef") },
				{ waitFor: "◆  Access Key ID", reply: enter("r2-access-key") },
				{ waitFor: "◆  Secret Access Key", reply: enter("r2-secret-key") },
				{ waitFor: "◆  Bucket", reply: enter("r2-bucket") },
			],
			configParts: ["type = s3", "provider = Cloudflare", "access_key_id = r2-access-key"],
			kitPart: "bucket: r2-bucket",
			secrets: ["r2-secret-key"],
		},
		{
			name: "AWS S3",
			steps: [
				{ waitFor: "Off-box destination", reply: moveUp(2) },
				{ waitFor: "S3 provider", reply: moveDown(2) },
				{ waitFor: "◆  Access key ID", reply: enter("aws-access-key") },
				{ waitFor: "◆  Secret access key", reply: enter("aws-secret-key") },
				{ waitFor: "◆  Region", reply: enter("eu-north-1") },
				{ waitFor: "◆  Bucket", reply: enter("aws-bucket") },
			],
			configParts: ["type = s3", "provider = AWS", "region = eu-north-1"],
			kitPart: "bucket: aws-bucket",
			secrets: ["aws-secret-key"],
		},
		{
			name: "other S3",
			steps: [
				{ waitFor: "Off-box destination", reply: moveUp(2) },
				{ waitFor: "S3 provider", reply: moveDown(3) },
				{ waitFor: "S3 endpoint", reply: enter("https://objects.example.test") },
				{ waitFor: "Access key ID", reply: enter("other-access-key") },
				{ waitFor: "Secret access key", reply: enter("other-secret-key") },
				{ waitFor: "Region (optional)", reply: enter("eu-test-1") },
				{ waitFor: "Bucket", reply: enter("other-bucket") },
				{ waitFor: "Prefix (optional)", reply: enter("private/packbat") },
			],
			configParts: ["type = s3", "endpoint = https://objects.example.test", "region = eu-test-1"],
			kitPart: "prefix: private/packbat",
			secrets: ["other-secret-key"],
		},
		{
			name: "SFTP",
			steps: [
				{ waitFor: "Off-box destination", reply: moveUp(1) },
				{ waitFor: "Server connection", reply: enter() },
				{ waitFor: "SFTP host", reply: enter("backup.example.test") },
				{ waitFor: "SFTP user", reply: enter("packbat") },
				{ waitFor: "Port (optional)", reply: enter("2222") },
				{ waitFor: "SSH key file (optional)", reply: enter("/keys/packbat") },
				{ waitFor: "Remote path", reply: enter("archive") },
			],
			configParts: ["type = sftp", "host = backup.example.test", "port = 2222"],
			kitPart: "path: archive",
			secrets: [],
		},
	])("connects $name with real local data-plane verification", async ({ steps, configParts, kitPart, secrets }) => {
		const home = await makeTempHome();
		homes.push(home);
		const proof = await runManagedLane({ home, steps });
		for (const part of configParts) expect(proof.config).toContain(part);
		expect(proof.kit).toContain(kitPart);
		for (const secret of secrets) expect(proof.output).not.toContain(secret);
	});

	test("connects Backblaze B2 and derives its restricted bucket", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" }).end(
				JSON.stringify({
					accountId: "account-id",
					authorizationToken: "authorization-token",
					apiInfo: {
						storageApi: {
							apiUrl: "https://api001.backblazeb2.com",
							s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
							allowed: {
								buckets: [{ id: "bucket-id", name: "restricted-bucket" }],
								capabilities: ["readFiles", "writeFiles"],
							},
						},
					},
				}),
			);
		});
		const port = await listen(server);
		try {
			const proof = await runManagedLane({
				home,
				env: await fetchRedirect(
					home,
					"https://api.backblazeb2.com/b2api/v4/b2_authorize_account",
					`http://127.0.0.1:${port}/authorize`,
				),
				steps: [
					{ waitFor: "Off-box destination", reply: moveUp(2) },
					{ waitFor: "S3 provider", reply: moveDown(1) },
					{ waitFor: "◆  keyID", reply: enter("b2-key-id") },
					{ waitFor: "◆  applicationKey", reply: enter("b2-application-key") },
				],
			});
			expect(proof.config).toContain("endpoint = https://s3.us-west-004.backblazeb2.com");
			expect(proof.kit).toContain("bucket: restricted-bucket");
			expect(proof.output).not.toContain("b2-application-key");
		} finally {
			await close(server);
		}
	});

	test("connects Google Drive through the headless continuation", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const token = JSON.stringify({
			access_token: "google-access-token",
			token_type: "Bearer",
			refresh_token: "google-refresh-token",
			expiry: "2099-01-01T00:00:00Z",
		});
		const proof = await runManagedLane({
			home,
			env: {
				...(await googleRcloneBoundary(home)),
				PACKBAT_GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
				PACKBAT_GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
			},
			steps: [
				{ waitFor: "Off-box destination", reply: moveUp(4) },
				{ waitFor: "Google Drive authorization", reply: moveDown(1) },
				{ waitFor: "Paste the rclone authorize result", reply: enter(token) },
			],
		});
		expect(proof.config).toContain("type = drive");
		expect(proof.config).toContain("token = {");
		expect(proof.kit).toContain("provider: google-drive");
		for (const secret of ["google-client-secret", "google-access-token", "google-refresh-token"]) {
			expect(proof.output).not.toContain(secret);
		}
		expect(proof.output).toContain("rclone authorize drive ");
	});

	test("connects Google Drive through the local browser flow", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const releaseCallbackPort = await acquireOAuthCallbackPort();
		const boundary = await googleBrowserBoundary(home);
		try {
			const proof = await runManagedLane({
				home,
				env: boundary.env,
				steps: [
					{ waitFor: "Off-box destination", reply: moveUp(4) },
					{ waitFor: "Google Drive authorization", reply: enter() },
				],
			});
			expect(proof.config).toContain("type = drive");
			expect(proof.config).toContain("google-browser-access-token");
			expect(proof.output).toContain("Google Drive authorization is valid");
			for (const secret of ["google-client-secret", "google-browser-access-token", "google-browser-refresh-token"]) {
				expect(proof.output).not.toContain(secret);
			}
		} finally {
			await close(boundary.server);
			await releaseCallbackPort();
		}
	});

	test("connects Dropbox through browser authorization", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const releaseCallbackPort = await acquireOAuthCallbackPort();
		const boundary = await dropboxBoundary(home);
		try {
			const proof = await runManagedLane({
				home,
				env: boundary.env,
				steps: [{ waitFor: "Off-box destination", reply: moveUp(3) }],
			});
			expect(proof.config).toContain("type = dropbox");
			expect(proof.kit).toContain("provider: dropbox");
			expect(proof.output).toContain("Dropbox authorization is valid");
			expect(proof.output).not.toContain("dropbox-access-token");
			expect(proof.output).not.toContain("dropbox-refresh-token");
		} finally {
			await close(boundary.server);
			await releaseCallbackPort();
		}
	});

	test("connects an existing rclone destination through the built CLI", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const remoteRoot = join(home, "remote");
		const kitPath = join(home, "packbat-recovery-kit.txt");
		const result = await runInteractiveCli(["init", "--no-activate"], { home, env: { PACKBAT_HOME: packbatHome } }, [
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Off-box destination", reply: moveUp(1) },
			{ waitFor: "Server connection", reply: moveDown(1) },
			{ waitFor: "Rclone destination", reply: enter(remoteRoot) },
			{ waitFor: "Rclone config", reply: enter() },
			{ waitFor: "Encryption key", reply: enter() },
			{ waitFor: "Recovery kit destination", reply: enter() },
			{ waitFor: "Recovery kit path", reply: enter() },
		]);

		expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(await readFile(join(packbatHome, "config.json"), "utf8")).toContain(remoteRoot);
		expect(await readFile(kitPath, "utf8")).toContain(`destination: ${remoteRoot}`);
		const identityPath = join(packbatHome, "identity.txt");
		const identity = (await readFile(identityPath, "utf8")).trim();
		const config = JSON.parse(await readFile(join(packbatHome, "config.json"), "utf8")) as {
			offbox: { recipient: string };
		};
		expect(await deriveTestRecipient(identity)).toBe(config.offbox.recipient);
		expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
		expect(`${result.stdout}${result.stderr}`).toContain("Done. Run `packbat status`.");
	}, 60_000);

	test("joins with an existing recovery kit without minting a new identity", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const remoteRoot = join(home, "remote");
		const kitPath = join(home, "existing-recovery-kit.txt");
		const { identity, recipient } = await generateTestIdentity();
		await writeFile(
			kitPath,
			renderRecoveryKit({
				identity,
				recipient,
				remotes: [{ type: "rclone", destination: remoteRoot }],
				createdAt: "2026-07-17T10:11:12.000Z",
			}),
		);

		const result = await runInteractiveCli(["init", "--no-activate"], { home, env: { PACKBAT_HOME: packbatHome } }, [
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Off-box destination", reply: moveUp(1) },
			{ waitFor: "Server connection", reply: moveDown(1) },
			{ waitFor: "Rclone destination", reply: enter(remoteRoot) },
			{ waitFor: "Rclone config", reply: enter() },
			{ waitFor: "Encryption key", reply: moveDown(1) },
			{ waitFor: "Recovery kit source", reply: moveDown(1) },
			{ waitFor: "Recovery kit path", reply: enter("~/existing-recovery-kit.txt") },
		]);

		const output = `${result.stdout}${result.stderr}`;
		expect(result.code, output).toBe(0);
		const identityPath = join(packbatHome, "identity.txt");
		expect(await readFile(identityPath, "utf8")).toBe(`${identity}\n`);
		expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
		const config = JSON.parse(await readFile(join(packbatHome, "config.json"), "utf8")) as {
			offbox: { recipient: string };
		};
		expect(config.offbox.recipient).toBe(recipient);
		expect(output).not.toContain("Recovery kit destination");
		expect(existsSync(join(home, "packbat-recovery-kit.txt"))).toBe(false);
	}, 60_000);

	test("re-prompts until the recovery kit matches the configured recipient", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const archiveRoot = join(home, "archive");
		const remoteRoot = join(home, "remote");
		const kitPath = join(home, "mismatched-recovery-kit.txt");
		const configured = await generateTestIdentity();
		const imported = await generateTestIdentity();
		await mkdir(packbatHome, { recursive: true });
		await writeFile(
			join(packbatHome, "config.json"),
			`${JSON.stringify({
				version: 2,
				machine: "test-machine",
				archiveRoot,
				sweep: { intervalMinutes: 60 },
				offbox: {
					mode: "configured",
					recipient: configured.recipient,
					remotes: [{ type: "rclone", destination: remoteRoot, rcloneConfig: "default" }],
				},
			})}\n`,
		);
		await writeFile(
			kitPath,
			renderRecoveryKit({
				...imported,
				remotes: [{ type: "rclone", destination: remoteRoot }],
				createdAt: "2026-07-17T10:11:12.000Z",
			}),
		);
		const matchingKitPath = join(home, "matching-recovery-kit.txt");
		await writeFile(
			matchingKitPath,
			renderRecoveryKit({
				...configured,
				remotes: [{ type: "rclone", destination: remoteRoot }],
				createdAt: "2026-07-17T10:11:12.000Z",
			}),
		);

		const result = await runInteractiveCli(["init", "--no-activate"], { home, env: { PACKBAT_HOME: packbatHome } }, [
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Recovery kit source", reply: moveDown(1) },
			{ waitFor: "Recovery kit path", reply: enter(kitPath) },
			{ waitFor: "does not match the configured age recipient", reply: enter(matchingKitPath) },
		]);

		const output = `${result.stdout}${result.stderr}`;
		expect(result.code, output).toBe(0);
		expect(output).not.toContain("Off-box destination");
		expect(await readFile(join(packbatHome, "identity.txt"), "utf8")).toBe(`${configured.identity}\n`);
	}, 60_000);

	test("joins by pasting the AGE-SECRET-KEY line", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const remoteRoot = join(home, "remote");
		const { identity, recipient } = await generateTestIdentity();

		const result = await runInteractiveCli(["init", "--no-activate"], { home, env: { PACKBAT_HOME: packbatHome } }, [
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Off-box destination", reply: moveUp(1) },
			{ waitFor: "Server connection", reply: moveDown(1) },
			{ waitFor: "Rclone destination", reply: enter(remoteRoot) },
			{ waitFor: "Rclone config", reply: enter() },
			{ waitFor: "Encryption key", reply: moveDown(1) },
			{ waitFor: "Recovery kit source", reply: enter() },
			{ waitFor: "◆  AGE-SECRET-KEY line", reply: enter(identity) },
		]);

		const output = `${result.stdout}${result.stderr}`;
		expect(result.code, output).toBe(0);
		expect(await readFile(join(packbatHome, "identity.txt"), "utf8")).toBe(`${identity}\n`);
		const config = JSON.parse(await readFile(join(packbatHome, "config.json"), "utf8")) as {
			offbox: { recipient: string };
		};
		expect(config.offbox.recipient).toBe(recipient);
		expect(output).not.toContain(identity);
	}, 60_000);

	test("re-prompts for a recovery kit path that does not exist", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const remoteRoot = join(home, "remote");
		const kitPath = join(home, "existing-recovery-kit.txt");
		const { identity, recipient } = await generateTestIdentity();
		await writeFile(
			kitPath,
			renderRecoveryKit({
				identity,
				recipient,
				remotes: [{ type: "rclone", destination: remoteRoot }],
				createdAt: "2026-07-17T10:11:12.000Z",
			}),
		);

		const result = await runInteractiveCli(["init", "--no-activate"], { home, env: { PACKBAT_HOME: packbatHome } }, [
			{ waitFor: "Archive root", reply: enter() },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Off-box destination", reply: moveUp(1) },
			{ waitFor: "Server connection", reply: moveDown(1) },
			{ waitFor: "Rclone destination", reply: enter(remoteRoot) },
			{ waitFor: "Rclone config", reply: enter() },
			{ waitFor: "Encryption key", reply: moveDown(1) },
			{ waitFor: "Recovery kit source", reply: moveDown(1) },
			{ waitFor: "Recovery kit path", reply: enter("~/missing-kit.txt") },
			{ waitFor: "No recovery kit at", reply: `${backspaces("~/missing-kit.txt".length)}${enter(kitPath)}` },
		]);

		const output = `${result.stdout}${result.stderr}`;
		expect(result.code, output).toBe(0);
		expect(await readFile(join(packbatHome, "identity.txt"), "utf8")).toBe(`${identity}\n`);
	}, 60_000);

	test("expands tilde paths for the archive root and the recovery kit", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const remoteRoot = join(home, "remote");
		const defaultArchiveRoot = join(packbatHome, "archive");
		const defaultKitPath = join(home, "packbat-recovery-kit.txt");

		const result = await runInteractiveCli(["init", "--no-activate"], { home, env: { PACKBAT_HOME: packbatHome } }, [
			{ waitFor: "Archive root", reply: `${backspaces(defaultArchiveRoot.length)}${enter("~/custom-archive")}` },
			{ waitFor: "Install this schedule?", reply: enter() },
			{ waitFor: "Off-box destination", reply: moveUp(1) },
			{ waitFor: "Server connection", reply: moveDown(1) },
			{ waitFor: "Rclone destination", reply: enter(remoteRoot) },
			{ waitFor: "Rclone config", reply: enter() },
			{ waitFor: "Encryption key", reply: enter() },
			{ waitFor: "Recovery kit destination", reply: enter() },
			{
				waitFor: "Recovery kit path",
				reply: `${backspaces(defaultKitPath.length)}${enter("~/kits/packbat-recovery-kit.txt")}`,
			},
		]);

		const output = `${result.stdout}${result.stderr}`;
		expect(result.code, output).toBe(0);
		expect(existsSync(join(home, "~"))).toBe(false);
		expect(await readFile(join(home, "kits", "packbat-recovery-kit.txt"), "utf8")).toContain("Packbat recovery kit");
		expect(output).toContain("Saved and read back the recovery kit");
		const config = JSON.parse(await readFile(join(packbatHome, "config.json"), "utf8")) as { archiveRoot: string };
		expect(config.archiveRoot).toBe(join(home, "custom-archive"));
	}, 60_000);
});
