import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

interface TokenResponse {
	accessToken: string;
	accessTokenExpiresAt: string;
	account: {
		graceEndsAt: string | null;
		githubLogin?: string;
		id: string;
		quotaBytes: number;
		reservedBytes: number;
		subscriptionState: "active" | "grace" | "inactive";
		usedBytes: number;
	};
	refreshToken: string;
	refreshTokenExpiresAt: string;
	tokenType: "Bearer";
}

afterEach(() => {
	vi.restoreAllMocks();
});

function jsonRequest(path: string, body: unknown, connectingIp = "192.0.2.1"): Request {
	return new Request(`https://api.packbat.dev${path}`, {
		body: JSON.stringify(body),
		headers: { "CF-Connecting-IP": connectingIp, "Content-Type": "application/json" },
		method: "POST",
	});
}

function mockGitHubUser(user: { id: number; login: string }, expectedToken = "github-token"): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		expect(request.method).toBe("GET");
		expect(request.url).toBe("https://api.github.com/user");
		expect(request.headers.get("Authorization")).toBe(`Bearer ${expectedToken}`);
		expect(request.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
		return Response.json(user);
	});
}

async function exchange(token = "github-token"): Promise<TokenResponse> {
	const response = await exports.default.fetch(jsonRequest("/v1/auth/github/exchange", { githubAccessToken: token }));
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	return (await response.json()) as TokenResponse;
}

async function refresh(refreshToken: string): Promise<Response> {
	return await exports.default.fetch(jsonRequest("/v1/auth/refresh", { refreshToken }));
}

describe("GitHub exchange", () => {
	it("keys an account by GitHub's numeric subject and stores no provider profile or token", async () => {
		mockGitHubUser({ id: 42_424, login: "octocat" });
		const first = await exchange();

		expect(first).toMatchObject({
			account: {
				graceEndsAt: null,
				githubLogin: "octocat",
				quotaBytes: 100_000_000_000,
				reservedBytes: 0,
				subscriptionState: "inactive",
				usedBytes: 0,
			},
			tokenType: "Bearer",
		});
		expect(first.refreshToken).toMatch(/^pb_refresh_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);

		const user = await env.DB.prepare("SELECT * FROM users").first<Record<string, unknown>>();
		expect(user).toMatchObject({ github_subject_id: "42424", id: first.account.id, quota_bytes: 100_000_000_000 });
		expect(user).not.toHaveProperty("plan");
		const storedState = JSON.stringify(
			await env.DB.prepare("SELECT users.*, cli_credentials.* FROM users JOIN cli_credentials").all(),
		);
		expect(storedState).not.toContain("github-token");
		expect(storedState).not.toContain("octocat");

		const schema = await env.DB.prepare(
			"SELECT name FROM pragma_table_info('users') UNION ALL SELECT name FROM pragma_table_info('cli_credentials')",
		).all<{ name: string }>();
		expect(schema.results.map(({ name }) => name)).not.toEqual(
			expect.arrayContaining(["email", "login", "name", "avatar", "github_access_token", "age_identity"]),
		);
	});

	it("reuses the account while issuing an independent CLI credential on each verified sign-in", async () => {
		mockGitHubUser({ id: 42_424, login: "octocat" });
		const first = await exchange();
		const second = await exchange();

		expect(second.account.id).toBe(first.account.id);
		expect(second.refreshToken).not.toBe(first.refreshToken);
		expect((await refresh(first.refreshToken)).status).toBe(200);
		expect((await refresh(second.refreshToken)).status).toBe(200);
	});

	it("rejects a provider token GitHub does not validate", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "Bad credentials" }, { status: 401 }));
		const response = await exports.default.fetch(
			jsonRequest("/v1/auth/github/exchange", { githubAccessToken: "invalid" }),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "invalid_github_token" });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()).toEqual({
			count: 0,
		});
	});

	it("bounds public exchange and refresh work by route and connecting IP without logging the IP", async () => {
		const provider = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ message: "Bad credentials" }, { status: 401 }));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const connectingIp = "198.51.100.24";
		const exchangeStatuses: number[] = [];
		for (let index = 0; index < 31; index += 1) {
			exchangeStatuses.push(
				(
					await exports.default.fetch(
						jsonRequest("/v1/auth/github/exchange", { githubAccessToken: "invalid" }, connectingIp),
					)
				).status,
			);
		}
		expect(exchangeStatuses.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 401));
		expect(exchangeStatuses.at(-1)).toBe(429);
		expect(provider).toHaveBeenCalledTimes(30);

		const refreshStatuses: number[] = [];
		for (let index = 0; index < 31; index += 1) {
			refreshStatuses.push(
				(await exports.default.fetch(jsonRequest("/v1/auth/refresh", { refreshToken: "invalid" }, connectingIp)))
					.status,
			);
		}
		expect(refreshStatuses.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 401));
		expect(refreshStatuses.at(-1)).toBe(429);
		expect(warning).not.toHaveBeenCalled();
	});
});

describe("CLI credentials", () => {
	it("rotates a refresh token once and rejects replay", async () => {
		mockGitHubUser({ id: 42_424, login: "octocat" });
		const linked = await exchange();
		const rotatedResponse = await refresh(linked.refreshToken);
		expect(rotatedResponse.status).toBe(200);
		const rotated = (await rotatedResponse.json()) as TokenResponse;
		expect(rotated.refreshToken).not.toBe(linked.refreshToken);

		const replay = await refresh(linked.refreshToken);
		expect(replay.status).toBe(401);
		expect(await replay.json()).toEqual({ error: "invalid_refresh_token" });
		expect((await refresh(rotated.refreshToken)).status).toBe(200);
	});

	it("allows only one concurrent rotation to win", async () => {
		mockGitHubUser({ id: 42_424, login: "octocat" });
		const linked = await exchange();
		const responses = await Promise.all([refresh(linked.refreshToken), refresh(linked.refreshToken)]);

		expect(responses.map(({ status }) => status).sort()).toEqual([200, 401]);
	});

	it("revokes the current credential and its access and refresh tokens", async () => {
		mockGitHubUser({ id: 42_424, login: "octocat" });
		const linked = await exchange();
		const revoke = await exports.default.fetch("https://api.packbat.dev/v1/auth/credential", {
			headers: { Authorization: `Bearer ${linked.accessToken}` },
			method: "DELETE",
		});

		expect(revoke.status).toBe(204);
		expect((await refresh(linked.refreshToken)).status).toBe(401);
		const repeated = await exports.default.fetch("https://api.packbat.dev/v1/auth/credential", {
			headers: { Authorization: `Bearer ${linked.accessToken}` },
			method: "DELETE",
		});
		expect(repeated.status).toBe(401);
	});
});

describe("account deletion", () => {
	it("deletes the account and every durable control-plane record", async () => {
		mockGitHubUser({ id: 42_424, login: "octocat" });
		const linked = await exchange();
		const userId = linked.account.id;
		const remoteId = crypto.randomUUID();
		const currentTime = Math.floor(Date.now() / 1_000);
		const account = await env.DB.prepare("SELECT storage_prefix FROM users WHERE id = ?")
			.bind(userId)
			.first<{ storage_prefix: string }>();
		expect(account).not.toBeNull();
		await env.DB.batch([
			env.DB.prepare("UPDATE users SET reserved_bytes = 100 WHERE id = ?").bind(userId),
			env.DB.prepare("INSERT INTO machine_remotes (id, user_id, created_at) VALUES (?, ?, ?)").bind(
				remoteId,
				userId,
				currentTime,
			),
			env.DB.prepare(
				"INSERT INTO object_ledger (user_id, machine_remote_id, logical_object_key, bytes, etag, last_completed_at) VALUES (?, ?, ?, ?, ?, ?)",
			).bind(userId, remoteId, "archive.age", 100, "etag", currentTime),
			env.DB.prepare(
				"INSERT INTO upload_reservations (id, user_id, machine_remote_id, logical_object_key, sweep_id, expected_bytes, checksum_sha256, replaced_bytes, idempotency_key, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(
				crypto.randomUUID(),
				userId,
				remoteId,
				"next.age",
				"deletion-sweep",
				100,
				"checksum",
				0,
				"idempotency-key",
				currentTime,
				currentTime + 300,
				"pending",
			),
			env.DB.prepare(
				"INSERT INTO billing_customers (user_id, provider, provider_customer_id, created_at) VALUES (?, 'stripe', ?, ?)",
			).bind(userId, "cus_test", currentTime),
			env.DB.prepare("INSERT INTO service_alerts (key, user_id, last_emitted_at) VALUES (?, ?, ?)").bind(
				`rate_limited:api_requests:${userId}`,
				userId,
				currentTime,
			),
		]);
		const prefix = `users/${account?.storage_prefix}/`;
		await Promise.all([
			env.ARCHIVE_BUCKET.put(`${prefix}machines/${remoteId}/archive.age`, new Uint8Array([1])),
			env.ARCHIVE_BUCKET.put(`${prefix}unledgered-ciphertext.age`, new Uint8Array([2])),
		]);

		const response = await exports.default.fetch("https://api.packbat.dev/v1/account", {
			headers: { Authorization: `Bearer ${linked.accessToken}` },
			method: "DELETE",
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ state: "deletion_pending" });
		expect(await env.ARCHIVE_BUCKET.head(`${prefix}machines/${remoteId}/next.age`)).toMatchObject({ size: 0 });
		expect(
			await env.DB.prepare("SELECT deletion_requested_at FROM users WHERE id = ?").bind(userId).first(),
		).not.toBeNull();
		const blockedMachine = await exports.default.fetch("https://api.packbat.dev/v1/machines", {
			body: "{}",
			headers: { Authorization: `Bearer ${linked.accessToken}`, "Content-Type": "application/json" },
			method: "POST",
		});
		expect(blockedMachine.status).toBe(409);
		expect(await blockedMachine.json()).toEqual({ error: "account_deleting" });

		await env.DB.prepare("UPDATE users SET delete_after = 0 WHERE id = ?").bind(userId).run();
		const completed = await exports.default.fetch("https://api.packbat.dev/v1/account", {
			headers: { Authorization: `Bearer ${linked.accessToken}` },
			method: "DELETE",
		});
		expect(completed.status).toBe(204);

		for (const table of [
			"billing_checkout_admissions",
			"billing_customers",
			"billing_subscriptions",
			"cli_credentials",
			"machine_remotes",
			"object_ledger",
			"service_alerts",
			"stripe_webhook_events",
			"upload_reservations",
			"users",
		]) {
			const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
			expect(count?.count, table).toBe(0);
		}
		expect((await env.ARCHIVE_BUCKET.list({ prefix })).objects).toEqual([]);
	});
});
