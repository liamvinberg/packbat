import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireOAuthCallbackPort, makeTempHome, runCli } from "./helpers/run-cli.js";

const TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
const APP_KEY = "synthetic-app-key";
const homes: string[] = [];

afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

interface ProviderFake {
	server: Server;
	accessToken: string;
	refreshToken: string;
	privateErrorDetail: string;
}

async function body(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function rejectAuthorization(response: ServerResponse, requestUrl: URL): void {
	const redirectUri = requestUrl.searchParams.get("redirect_uri");
	const state = requestUrl.searchParams.get("state");
	if (redirectUri === null || state === null) {
		response.writeHead(400).end();
		return;
	}
	const rejected = new URL(redirectUri);
	rejected.search = new URLSearchParams({ error: "invalid_request", state }).toString();
	response.writeHead(302, { Location: rejected.toString() }).end();
}

function createProviderFake(tokenOutcome: "success" | "error"): ProviderFake {
	const authorizationCode = randomBytes(24).toString("base64url");
	const accessToken = randomBytes(32).toString("base64url");
	const refreshToken = randomBytes(32).toString("base64url");
	const privateErrorDetail = randomBytes(32).toString("base64url");
	let expectedChallenge: string | undefined;
	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		try {
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			if (requestUrl.pathname === "/authorize") {
				const expectedKeys = [
					"client_id",
					"code_challenge",
					"code_challenge_method",
					"redirect_uri",
					"response_type",
					"state",
					"token_access_type",
				].sort();
				const actualKeys = [...requestUrl.searchParams.keys()].sort();
				const redirectUri = requestUrl.searchParams.get("redirect_uri");
				const state = requestUrl.searchParams.get("state");
				expectedChallenge = requestUrl.searchParams.get("code_challenge") ?? undefined;
				if (
					JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
					requestUrl.searchParams.get("client_id") !== APP_KEY ||
					requestUrl.searchParams.get("code_challenge_method") !== "S256" ||
					requestUrl.searchParams.get("redirect_uri") !== "http://localhost:53682/" ||
					requestUrl.searchParams.get("response_type") !== "code" ||
					requestUrl.searchParams.get("token_access_type") !== "offline" ||
					expectedChallenge?.match(/^[A-Za-z0-9_-]{43}$/u) === null ||
					state?.match(/^[A-Za-z0-9_-]{43}$/u) === null ||
					redirectUri === null ||
					state === null
				) {
					rejectAuthorization(response, requestUrl);
					return;
				}
				const wrongState = new URL(redirectUri);
				wrongState.search = new URLSearchParams({ code: "wrong-code", state: `${state}-wrong` }).toString();
				if ((await fetch(wrongState)).status !== 400) {
					rejectAuthorization(response, requestUrl);
					return;
				}
				const accepted = new URL(redirectUri);
				accepted.search = new URLSearchParams({ code: authorizationCode, state }).toString();
				response.writeHead(302, { Location: accepted.toString() }).end();
				return;
			}
			if (requestUrl.pathname === "/token") {
				const tokenBody = new URLSearchParams(await body(request));
				const verifier = tokenBody.get("code_verifier") ?? "";
				const actualChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
				const expectedKeys = ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"].sort();
				const actualKeys = [...tokenBody.keys()].sort();
				if (
					JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
					tokenBody.get("client_id") !== APP_KEY ||
					tokenBody.get("code") !== authorizationCode ||
					tokenBody.get("grant_type") !== "authorization_code" ||
					tokenBody.get("redirect_uri") !== "http://localhost:53682/" ||
					verifier.match(/^[A-Za-z0-9_-]{86}$/u) === null ||
					actualChallenge !== expectedChallenge
				) {
					response.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"invalid_request"}');
					return;
				}
				if (tokenOutcome === "error") {
					response.writeHead(400, { "Content-Type": "application/json" }).end(
						JSON.stringify({
							error: "invalid_grant",
							error_description: privateErrorDetail,
						}),
					);
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						access_token: accessToken,
						expires_in: 14_400,
						refresh_token: refreshToken,
						token_type: "bearer",
					}),
				);
				return;
			}
			response.writeHead(404).end();
		} catch {
			response.writeHead(500).end();
		}
	});
	return { server, accessToken, refreshToken, privateErrorDetail };
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") reject(new Error("provider fake did not bind a TCP port"));
			else resolve(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) resolve();
			else reject(error);
		});
	});
}

async function createFetchBoundary(home: string, tokenUrl: string): Promise<Record<string, string>> {
	const fetchHookPath = join(home, "dropbox-fetch-hook.mjs");
	await writeFile(
		fetchHookPath,
		`const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return originalFetch(url === ${JSON.stringify(TOKEN_ENDPOINT)} ? process.env.PACKBAT_TEST_TOKEN_URL : input, init);
};
`,
		{ mode: 0o600 },
	);
	return {
		NODE_OPTIONS: `--import=${fetchHookPath}`,
		PACKBAT_TEST_TOKEN_URL: tokenUrl,
	};
}

async function createBrowserAndFetchBoundary(home: string, authorizationUrl: string, tokenUrl: string) {
	const binPath = join(home, "bin");
	const browserPath = join(binPath, "open");
	await mkdir(binPath, { recursive: true });
	await writeFile(
		browserPath,
		`#!/usr/bin/env node
const source = new URL(process.argv[2]);
const destination = new URL(process.env.PACKBAT_TEST_AUTHORIZATION_URL);
destination.search = source.search;
fetch(destination).then((response) => response.arrayBuffer()).catch(() => { process.exitCode = 1; });
`,
		{ mode: 0o700 },
	);
	await chmod(browserPath, 0o700);
	return {
		...(await createFetchBoundary(home, tokenUrl)),
		PACKBAT_TEST_AUTHORIZATION_URL: authorizationUrl,
		PATH: `${binPath}${delimiter}${process.env.PATH ?? ""}`,
	};
}

async function runAgainstProvider(tokenOutcome: "success" | "error") {
	const releaseCallbackPort = await acquireOAuthCallbackPort();
	const home = await makeTempHome();
	homes.push(home);
	const packbatHome = join(home, ".packbat");
	const provider = createProviderFake(tokenOutcome);
	const port = await listen(provider.server);
	try {
		const env = await createBrowserAndFetchBoundary(
			home,
			`http://127.0.0.1:${port}/authorize`,
			`http://127.0.0.1:${port}/token`,
		);
		const result = await runCli(["_dropbox-oauth", "--app-key", APP_KEY], {
			home,
			env: { ...env, PACKBAT_HOME: packbatHome },
		});
		return { ...provider, configPath: join(packbatHome, "rclone.conf"), result };
	} finally {
		await close(provider.server);
		await releaseCallbackPort();
	}
}

describe.sequential("Dropbox OAuth process boundary", () => {
	test("authorizes through the built CLI and writes a private no-secret rclone config", async () => {
		const proof = await runAgainstProvider("success");

		expect(proof.result.code).toBe(0);
		expect(proof.result.stderr).toBe("");
		expect(proof.result.stdout).toContain("Opened your browser to authorize Dropbox.");
		expect(proof.result.stdout).toContain("https://www.dropbox.com/oauth2/authorize?");
		expect(proof.result.stdout).toContain("Dropbox authorization complete.\n");
		const config = await readFile(proof.configPath, "utf8");
		expect(config).toContain("[packbat]\ntype = dropbox\n");
		expect(config).toContain(`client_id = ${APP_KEY}\n`);
		expect(config).toContain(`"access_token":"${proof.accessToken}"`);
		expect(config).toContain(`"refresh_token":"${proof.refreshToken}"`);
		expect(config).not.toContain("client_secret");
		expect((await stat(proof.configPath)).mode & 0o777).toBe(0o600);
		expect(`${proof.result.stdout}${proof.result.stderr}`).not.toContain(proof.accessToken);
		expect(`${proof.result.stdout}${proof.result.stderr}`).not.toContain(proof.refreshToken);
	});

	test("keeps provider error bodies out of CLI errors and leaves no config", async () => {
		const proof = await runAgainstProvider("error");

		expect(proof.result.code).toBe(1);
		expect(proof.result.stderr).toBe("packbat: Dropbox token exchange failed (HTTP 400)\n");
		expect(proof.result.stderr).not.toContain(proof.privateErrorDetail);
		await expect(stat(proof.configPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("authorizes headless with a pasted code, no redirect URI, and no callback listener", async () => {
		const home = await makeTempHome();
		homes.push(home);
		const packbatHome = join(home, ".packbat");
		const authorizationCode = randomBytes(24).toString("base64url");
		const accessToken = randomBytes(32).toString("base64url");
		const refreshToken = randomBytes(32).toString("base64url");
		let recordedVerifier = "";
		let recordedKeys: string[] = [];
		const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
			try {
				const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
				if (requestUrl.pathname !== "/token") {
					response.writeHead(404).end();
					return;
				}
				const tokenBody = new URLSearchParams(await body(request));
				recordedVerifier = tokenBody.get("code_verifier") ?? "";
				recordedKeys = [...tokenBody.keys()].sort();
				if (tokenBody.get("code") !== authorizationCode) {
					response.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"invalid_grant"}');
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						access_token: accessToken,
						expires_in: 14_400,
						refresh_token: refreshToken,
						token_type: "bearer",
					}),
				);
			} catch {
				response.writeHead(500).end();
			}
		});
		const port = await listen(server);
		try {
			const env = await createFetchBoundary(home, `http://127.0.0.1:${port}/token`);
			const result = await runCli(["_dropbox-oauth", "--app-key", APP_KEY, "--headless"], {
				home,
				env: { ...env, PACKBAT_HOME: packbatHome },
				stdin: `${authorizationCode}\n`,
			});

			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("Open this link in any browser:");
			expect(result.stdout).toContain("Paste the code Dropbox shows:");
			expect(result.stdout).toContain("Dropbox authorization complete.\n");
			const printedUrl = result.stdout.match(/https:\/\/www\.dropbox\.com\/oauth2\/authorize\?\S+/u)?.[0];
			expect(printedUrl).toBeDefined();
			const query = new URL(printedUrl ?? "").searchParams;
			expect([...query.keys()].sort()).toEqual([
				"client_id",
				"code_challenge",
				"code_challenge_method",
				"response_type",
				"token_access_type",
			]);
			expect(query.get("client_id")).toBe(APP_KEY);
			expect(query.get("code_challenge_method")).toBe("S256");
			expect(query.get("token_access_type")).toBe("offline");
			expect(recordedKeys).toEqual(["client_id", "code", "code_verifier", "grant_type"]);
			expect(createHash("sha256").update(recordedVerifier, "ascii").digest("base64url")).toBe(
				query.get("code_challenge"),
			);
			const config = await readFile(join(packbatHome, "rclone.conf"), "utf8");
			expect(config).toContain("[packbat]\ntype = dropbox\n");
			expect(config).toContain(`"access_token":"${accessToken}"`);
			expect(config).toContain(`"refresh_token":"${refreshToken}"`);
			expect((await stat(join(packbatHome, "rclone.conf"))).mode & 0o777).toBe(0o600);
			expect(result.stdout).not.toContain(accessToken);
			expect(result.stdout).not.toContain(refreshToken);
		} finally {
			await close(server);
		}
	});
});
