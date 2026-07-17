import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { deliverStripeEvent, subscriptionEvent } from "./helpers/stripe.js";

interface LinkedAccount {
	accessToken: string;
	account: { id: string; quotaBytes: number; reservedBytes: number; usedBytes: number };
}

interface ReservationResponse {
	reservationId: string;
	state: "pending";
	upload: {
		expiresAt: string;
		headers: Record<string, string>;
		url: string;
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

function jsonRequest(path: string, body: unknown, accessToken?: string): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (accessToken !== undefined) {
		headers.Authorization = `Bearer ${accessToken}`;
	}
	return new Request(`https://api.packbat.dev${path}`, {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

function mockGitHubUsers(usersByToken: Record<string, { id: number; login: string }>): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		if (request.url === "https://api.stripe.com/v1/customers") {
			const body = new TextDecoder().decode(await request.arrayBuffer());
			const userId = new URLSearchParams(body).get("metadata[packbat_user_id]");
			if (userId === null) {
				throw new Error("Stripe customer request had no Packbat user ID");
			}
			return Response.json({ id: `cus_${userId.replaceAll("-", "")}` });
		}
		if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
			return Response.json({ id: "cs_test_storage", url: "https://checkout.stripe.com/c/pay/test" });
		}
		const authorization = request.headers.get("Authorization");
		const token = authorization?.replace(/^Bearer /u, "");
		const user = token === undefined ? undefined : usersByToken[token];
		return user === undefined ? Response.json({ message: "Bad credentials" }, { status: 401 }) : Response.json(user);
	});
}

async function exchange(githubAccessToken = "github-token"): Promise<LinkedAccount> {
	const response = await exports.default.fetch(jsonRequest("/v1/auth/github/exchange", { githubAccessToken }));
	expect(response.status).toBe(200);
	const linked = (await response.json()) as LinkedAccount;
	const checkout = await exports.default.fetch(
		jsonRequest(
			"/v1/billing/checkout",
			{ idempotencyKey: `storage-${linked.account.id}`, interval: "month" },
			linked.accessToken,
		),
	);
	expect(checkout.status).toBe(201);
	const suffix = linked.account.id.replaceAll("-", "");
	const currentTime = Math.floor(Date.now() / 1_000);
	const activated = await deliverStripeEvent(
		subscriptionEvent({
			created: currentTime,
			customerId: `cus_${suffix}`,
			eventId: `evt_storage_${suffix}`,
			status: "active",
			subscriptionId: `sub_${suffix}`,
			type: "customer.subscription.created",
			userId: linked.account.id,
		}),
		currentTime,
	);
	expect(activated.status).toBe(200);
	return linked;
}

async function createMachine(accessToken: string): Promise<string> {
	const response = await exports.default.fetch(jsonRequest("/v1/machines", {}, accessToken));
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

function bytesToBase64(value: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(value)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

async function checksum(bytes: Uint8Array): Promise<{ digest: ArrayBuffer; value: string }> {
	const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
	return { digest, value: bytesToBase64(digest) };
}

async function reserve(
	accessToken: string,
	input: {
		bytes: Uint8Array;
		expectedArchiveCount?: number;
		expectedIndexEtag?: string | null;
		idempotencyKey: string;
		logicalObjectKey: string;
		machineRemoteId: string;
		sweepId?: string;
	},
): Promise<Response> {
	const expectedChecksum = await checksum(input.bytes);
	const { bytes, ...rest } = input;
	return await exports.default.fetch(
		jsonRequest(
			"/v1/uploads/reservations",
			{
				...rest,
				checksumSha256: expectedChecksum.value,
				expectedBytes: bytes.byteLength,
				sweepId: input.sweepId ?? input.idempotencyKey,
			},
			accessToken,
		),
	);
}

async function storagePrefix(userId: string): Promise<string> {
	const account = await env.DB.prepare("SELECT storage_prefix AS storagePrefix FROM users WHERE id = ?")
		.bind(userId)
		.first<{ storagePrefix: string }>();
	if (account === null) {
		throw new Error("test account has no storage prefix");
	}
	return account.storagePrefix;
}

async function putObject(
	userId: string,
	machineRemoteId: string,
	logicalObjectKey: string,
	bytes: Uint8Array,
): Promise<R2Object> {
	const expectedChecksum = await checksum(bytes);
	const object = await env.ARCHIVE_BUCKET.put(
		`users/${await storagePrefix(userId)}/machines/${machineRemoteId}/${logicalObjectKey}`,
		bytes,
		{
			httpMetadata: { cacheControl: "no-store", contentType: "application/octet-stream" },
			sha256: expectedChecksum.digest,
		},
	);
	if (object === null) {
		throw new Error("test R2 PUT did not create an object");
	}
	return object;
}

async function finalize(accessToken: string, reservationId: string): Promise<Response> {
	return await exports.default.fetch(jsonRequest(`/v1/uploads/${reservationId}/finalize`, {}, accessToken));
}

describe("ciphertext uploads", () => {
	it("reserves, signs, verifies, accounts, and downloads one exact object", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const bytes = new TextEncoder().encode("ciphertext");
		const logicalObjectKey = "claude/projects/session.jsonl.zst.age";

		const response = await reserve(linked.accessToken, {
			bytes,
			idempotencyKey: "first-upload",
			logicalObjectKey,
			machineRemoteId,
		});
		expect(response.status).toBe(201);
		const reservation = (await response.json()) as ReservationResponse;
		expect(reservation.state).toBe("pending");
		expect(reservation.upload.headers).toEqual({
			"Cache-Control": "no-store",
			"Content-Length": String(bytes.byteLength),
			"Content-Type": "application/octet-stream",
			"If-None-Match": "*",
			"x-amz-checksum-sha256": (await checksum(bytes)).value,
		});
		const uploadUrl = new URL(reservation.upload.url);
		expect(uploadUrl.host).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
		expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
			expect.arrayContaining([
				"cache-control",
				"content-length",
				"content-type",
				"host",
				"if-none-match",
				"x-amz-checksum-sha256",
			]),
		);
		expect(reservation.upload.url).not.toContain(linked.account.id);

		const repeated = await reserve(linked.accessToken, {
			bytes,
			idempotencyKey: "first-upload",
			logicalObjectKey,
			machineRemoteId,
		});
		expect(repeated.status).toBe(200);
		expect((await repeated.json()) as ReservationResponse).toMatchObject({
			reservationId: reservation.reservationId,
			state: "pending",
		});

		const stored = await putObject(linked.account.id, machineRemoteId, logicalObjectKey, bytes);
		const finalized = await Promise.all([
			finalize(linked.accessToken, reservation.reservationId),
			finalize(linked.accessToken, reservation.reservationId),
		]);
		expect(finalized.map(({ status }) => status)).toEqual([200, 200]);
		expect(await Promise.all(finalized.map(async (item) => await item.json()))).toEqual([
			{ etag: stored.etag },
			{ etag: stored.etag },
		]);
		expect(await (await finalize(linked.accessToken, reservation.reservationId)).json()).toEqual({ etag: stored.etag });

		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 0, used_bytes: bytes.byteLength });

		const download = await exports.default.fetch(
			jsonRequest("/v1/downloads", { logicalObjectKey, machineRemoteId }, linked.accessToken),
		);
		expect(download.status).toBe(200);
		const downloadBody = (await download.json()) as { expiresAt: string; url: string };
		expect(new URL(downloadBody.url).searchParams.get("X-Amz-SignedHeaders")).toBe("host");

		const suffix = linked.account.id.replaceAll("-", "");
		const currentTime = Math.floor(Date.now() / 1_000);
		const lapsed = await deliverStripeEvent(
			subscriptionEvent({
				created: currentTime + 1,
				customerId: `cus_${suffix}`,
				eventId: `evt_storage_lapsed_${suffix}`,
				status: "past_due",
				subscriptionId: `sub_${suffix}`,
				userId: linked.account.id,
			}),
			currentTime,
		);
		expect(lapsed.status).toBe(200);
		const frozen = await reserve(linked.accessToken, {
			bytes: new Uint8Array([9]),
			idempotencyKey: "frozen-during-grace",
			logicalObjectKey: "claude/frozen.age",
			machineRemoteId,
		});
		expect(frozen.status).toBe(402);
		expect(await frozen.json()).toEqual({ error: "subscription_required" });
		const graceDownload = await exports.default.fetch(
			jsonRequest("/v1/downloads", { logicalObjectKey, machineRemoteId }, linked.accessToken),
		);
		expect(graceDownload.status).toBe(200);
	});

	it("admits concurrent reservations only while their total stays under quota", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		await env.DB.prepare("UPDATE users SET quota_bytes = 10 WHERE id = ?").bind(linked.account.id).run();

		const responses = await Promise.all([
			reserve(linked.accessToken, {
				bytes: new Uint8Array(7),
				idempotencyKey: "quota-a",
				logicalObjectKey: "claude/a.age",
				machineRemoteId,
			}),
			reserve(linked.accessToken, {
				bytes: new Uint8Array(7),
				idempotencyKey: "quota-b",
				logicalObjectKey: "claude/b.age",
				machineRemoteId,
			}),
		]);

		expect(responses.map(({ status }) => status).sort()).toEqual([201, 413]);
		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 7, used_bytes: 0 });
	});

	it("moves replaced bytes between used and reserved accounting and restores them on expiry", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const logicalObjectKey = "opencode/session.age";
		await env.DB.prepare("UPDATE users SET quota_bytes = 10 WHERE id = ?").bind(linked.account.id).run();

		const initialBytes = new Uint8Array(8);
		const initialResponse = await reserve(linked.accessToken, {
			bytes: initialBytes,
			idempotencyKey: "initial-version",
			logicalObjectKey,
			machineRemoteId,
		});
		const initial = (await initialResponse.json()) as ReservationResponse;
		const initialObject = await putObject(linked.account.id, machineRemoteId, logicalObjectKey, initialBytes);
		expect((await finalize(linked.accessToken, initial.reservationId)).status).toBe(200);

		const replacementBytes = new Uint8Array(6);
		const replacementResponse = await reserve(linked.accessToken, {
			bytes: replacementBytes,
			idempotencyKey: "replacement-version",
			logicalObjectKey,
			machineRemoteId,
		});
		const replacement = (await replacementResponse.json()) as ReservationResponse;
		expect(replacement.upload.headers["If-Match"]).toBe(`"${initialObject.etag}"`);
		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 6, used_bytes: 0 });
		await putObject(linked.account.id, machineRemoteId, logicalObjectKey, replacementBytes);
		expect((await finalize(linked.accessToken, replacement.reservationId)).status).toBe(200);
		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 0, used_bytes: 6 });

		const expiringResponse = await reserve(linked.accessToken, {
			bytes: new Uint8Array(5),
			idempotencyKey: "expiring-replacement",
			logicalObjectKey,
			machineRemoteId,
		});
		const expiring = (await expiringResponse.json()) as ReservationResponse;
		await env.DB.prepare("UPDATE upload_reservations SET created_at = 0, expires_at = 1 WHERE id = ?")
			.bind(expiring.reservationId)
			.run();

		const next = await reserve(linked.accessToken, {
			bytes: new Uint8Array(4),
			idempotencyKey: "other-object",
			logicalObjectKey: "opencode/other.age",
			machineRemoteId,
		});
		expect(next.status).toBe(201);
		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 4, used_bytes: 6 });
		const expired = await reserve(linked.accessToken, {
			bytes: new Uint8Array(5),
			idempotencyKey: "expiring-replacement",
			logicalObjectKey,
			machineRemoteId,
		});
		expect(expired.status).toBe(200);
		expect(await expired.json()).toMatchObject({ reservationId: expiring.reservationId, state: "expired" });
	});

	it("reconciles an expired uploaded object before releasing another reservation", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const firstBytes = new Uint8Array([1, 2, 3]);
		const firstResponse = await reserve(linked.accessToken, {
			bytes: firstBytes,
			idempotencyKey: "expired-upload",
			logicalObjectKey: "codex/first.age",
			machineRemoteId,
		});
		const first = (await firstResponse.json()) as ReservationResponse;
		await putObject(linked.account.id, machineRemoteId, "codex/first.age", firstBytes);
		await env.DB.prepare("UPDATE upload_reservations SET created_at = 0, expires_at = 1 WHERE id = ?")
			.bind(first.reservationId)
			.run();

		const second = await reserve(linked.accessToken, {
			bytes: new Uint8Array([4, 5]),
			idempotencyKey: "next-upload",
			logicalObjectKey: "codex/second.age",
			machineRemoteId,
		});
		expect(second.status).toBe(201);
		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 2, used_bytes: 3 });
		const completed = await reserve(linked.accessToken, {
			bytes: firstBytes,
			idempotencyKey: "expired-upload",
			logicalObjectKey: "codex/first.age",
			machineRemoteId,
		});
		expect(completed.status).toBe(200);
		expect(await completed.json()).toMatchObject({ reservationId: first.reservationId, state: "completed" });
	});

	it("repairs authoritative used and reserved counters from the ledger and live reservations", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const pending = await reserve(linked.accessToken, {
			bytes: new Uint8Array([1, 2, 3]),
			idempotencyKey: "accounting-repair",
			logicalObjectKey: "codex/accounting.age",
			machineRemoteId,
		});
		expect(pending.status).toBe(201);
		await env.DB.prepare("UPDATE users SET used_bytes = 77, reserved_bytes = 88 WHERE id = ?")
			.bind(linked.account.id)
			.run();

		await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);

		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 3, used_bytes: 0 });
	});

	it("does not erase a reservation admitted concurrently with scheduled accounting repair", async () => {
		const currentTime = Math.floor(Date.now() / 1_000);
		const sentinelUserId = "accounting-sentinel";
		const targetUserId = "accounting-target";
		const machineRemoteId = "accounting-machine";
		const userIds = [
			sentinelUserId,
			...Array.from({ length: 40 }, (_, index) => `accounting-filler-${index}`),
			targetUserId,
		];
		await env.DB.batch(
			userIds.map((userId, index) =>
				env.DB.prepare(
					`INSERT INTO users (
						id, github_subject_id, created_at, quota_bytes, used_bytes, reserved_bytes, storage_prefix
					) VALUES (?, ?, ?, ?, 77, 88, ?)`,
				).bind(userId, String(900_000 + index), currentTime, 100, `accounting/${index}`),
			),
		);
		await env.DB.prepare("INSERT INTO machine_remotes (id, user_id, created_at) VALUES (?, ?, ?)")
			.bind(machineRemoteId, targetUserId, currentTime)
			.run();

		const scheduled = worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const sentinel = await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?")
				.bind(sentinelUserId)
				.first<{ reserved_bytes: number; used_bytes: number }>();
			if (sentinel?.used_bytes === 0 && sentinel.reserved_bytes === 0) {
				break;
			}
			if (attempt === 99) {
				throw new Error("scheduled accounting repair did not start");
			}
		}
		const admission = env.DB.batch([
			env.DB.prepare("UPDATE users SET reserved_bytes = reserved_bytes + 3 WHERE id = ?").bind(targetUserId),
			env.DB.prepare(
				`INSERT INTO upload_reservations (
					id, user_id, machine_remote_id, logical_object_key, sweep_id, expected_bytes,
					checksum_sha256, replaced_bytes, idempotency_key, created_at, expires_at, state
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
			).bind(
				crypto.randomUUID(),
				targetUserId,
				machineRemoteId,
				"codex/concurrent-accounting.age",
				"concurrent-accounting",
				3,
				"checksum",
				0,
				"concurrent-accounting",
				currentTime,
				currentTime + 300,
			),
		]);
		await Promise.all([scheduled, admission]);

		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(targetUserId).first(),
		).toEqual({ reserved_bytes: 3, used_bytes: 0 });
	});

	it("refuses finalization and removes an object whose length or checksum differs", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const logicalObjectKey = "gemini/mismatch.age";
		const response = await reserve(linked.accessToken, {
			bytes: new Uint8Array([1, 2, 3]),
			idempotencyKey: "mismatch",
			logicalObjectKey,
			machineRemoteId,
		});
		const reservation = (await response.json()) as ReservationResponse;
		await putObject(linked.account.id, machineRemoteId, logicalObjectKey, new Uint8Array([1, 2, 3, 4]));

		const finalized = await finalize(linked.accessToken, reservation.reservationId);
		expect(finalized.status).toBe(409);
		expect(await finalized.json()).toEqual({ error: "upload_mismatch" });
		expect(
			await env.ARCHIVE_BUCKET.head(
				`users/${await storagePrefix(linked.account.id)}/machines/${machineRemoteId}/${logicalObjectKey}`,
			),
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ reserved_bytes: 3, used_bytes: 0 });
	});

	it("finalizes an exact S3 upload when the Workers binding omits its SHA-256", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const logicalObjectKey = "claude/s3-checksum.age";
		const bytes = new Uint8Array([1, 2, 3]);
		const response = await reserve(linked.accessToken, {
			bytes,
			idempotencyKey: "s3-checksum",
			logicalObjectKey,
			machineRemoteId,
		});
		const reservation = (await response.json()) as ReservationResponse;
		const key = `users/${await storagePrefix(linked.account.id)}/machines/${machineRemoteId}/${logicalObjectKey}`;
		const object = await env.ARCHIVE_BUCKET.put(key, bytes, {
			httpMetadata: { cacheControl: "no-store", contentType: "application/octet-stream" },
		});
		if (object === null) throw new Error("test R2 PUT did not create an object");
		expect(object.checksums.sha256).toBeUndefined();

		const finalized = await finalize(linked.accessToken, reservation.reservationId);
		expect(finalized.status).toBe(200);
		expect(await finalized.json()).toEqual({ etag: object.etag });
	});

	it("refuses finalization when ciphertext carries extra metadata", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const logicalObjectKey = "claude/metadata.age";
		const bytes = new Uint8Array([1, 2, 3]);
		const response = await reserve(linked.accessToken, {
			bytes,
			idempotencyKey: "metadata",
			logicalObjectKey,
			machineRemoteId,
		});
		const reservation = (await response.json()) as ReservationResponse;
		const expectedChecksum = await checksum(bytes);
		const key = `users/${await storagePrefix(linked.account.id)}/machines/${machineRemoteId}/${logicalObjectKey}`;
		await env.ARCHIVE_BUCKET.put(key, bytes, {
			customMetadata: { hostname: "private-machine" },
			httpMetadata: { cacheControl: "private", contentType: "application/octet-stream" },
			sha256: expectedChecksum.digest,
		});

		const finalized = await finalize(linked.accessToken, reservation.reservationId);
		expect(finalized.status).toBe(409);
		expect(await finalized.json()).toEqual({ error: "upload_mismatch" });
		expect(await env.ARCHIVE_BUCKET.head(key)).toBeNull();
	});

	it("removes abandoned uploads with forbidden metadata after reservation expiry", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const logicalObjectKey = "claude/abandoned.age";
		const bytes = new Uint8Array([1, 2, 3]);
		const response = await reserve(linked.accessToken, {
			bytes,
			idempotencyKey: "abandoned-metadata",
			logicalObjectKey,
			machineRemoteId,
		});
		const reservation = (await response.json()) as ReservationResponse;
		await env.DB.prepare("UPDATE upload_reservations SET created_at = 0, expires_at = 1 WHERE id = ?")
			.bind(reservation.reservationId)
			.run();
		const expectedChecksum = await checksum(bytes);
		const key = `users/${await storagePrefix(linked.account.id)}/machines/${machineRemoteId}/${logicalObjectKey}`;
		await env.ARCHIVE_BUCKET.put(key, bytes, {
			customMetadata: { hostname: "private-machine" },
			httpMetadata: { contentType: "application/octet-stream" },
			sha256: expectedChecksum.digest,
		});

		await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);

		expect(await env.ARCHIVE_BUCKET.head(key)).toBeNull();
		const expired = await reserve(linked.accessToken, {
			bytes,
			idempotencyKey: "abandoned-metadata",
			logicalObjectKey,
			machineRemoteId,
		});
		expect(expired.status).toBe(200);
		expect(await expired.json()).toMatchObject({ reservationId: reservation.reservationId, state: "expired" });
	});
});

describe("index publication", () => {
	it("keeps archives before the index and makes every index update conditional", async () => {
		mockGitHubUsers({ "github-token": { id: 42_424, login: "octocat" } });
		const linked = await exchange();
		const machineRemoteId = await createMachine(linked.accessToken);
		const firstSweepId = "first-index-sweep";
		const prematureIndex = await reserve(linked.accessToken, {
			bytes: new Uint8Array([2]),
			expectedArchiveCount: 1,
			expectedIndexEtag: null,
			idempotencyKey: "premature-index",
			logicalObjectKey: "index.jsonl.age",
			machineRemoteId,
			sweepId: firstSweepId,
		});
		expect(prematureIndex.status).toBe(409);
		expect(await prematureIndex.json()).toEqual({ error: "sweep_incomplete" });

		const archiveBytes = new Uint8Array([1]);
		const archiveResponse = await reserve(linked.accessToken, {
			bytes: archiveBytes,
			idempotencyKey: "archive",
			logicalObjectKey: "claude/archive.age",
			machineRemoteId,
			sweepId: firstSweepId,
		});
		const archive = (await archiveResponse.json()) as ReservationResponse;

		const blockedIndex = await reserve(linked.accessToken, {
			bytes: new Uint8Array([2]),
			expectedArchiveCount: 1,
			expectedIndexEtag: null,
			idempotencyKey: "blocked-index",
			logicalObjectKey: "index.jsonl.age",
			machineRemoteId,
			sweepId: firstSweepId,
		});
		expect(blockedIndex.status).toBe(409);
		expect(await blockedIndex.json()).toEqual({ error: "archives_pending" });

		await putObject(linked.account.id, machineRemoteId, "claude/archive.age", archiveBytes);
		expect((await finalize(linked.accessToken, archive.reservationId)).status).toBe(200);

		const firstIndexBytes = new Uint8Array([2]);
		const firstIndexResponse = await reserve(linked.accessToken, {
			bytes: firstIndexBytes,
			expectedArchiveCount: 1,
			expectedIndexEtag: null,
			idempotencyKey: "first-index",
			logicalObjectKey: "index.jsonl.age",
			machineRemoteId,
			sweepId: firstSweepId,
		});
		expect(firstIndexResponse.status).toBe(201);
		const firstIndex = (await firstIndexResponse.json()) as ReservationResponse;
		expect(firstIndex.upload.headers["If-None-Match"]).toBe("*");
		expect(new URL(firstIndex.upload.url).searchParams.get("X-Amz-SignedHeaders")).toContain("if-none-match");
		const lateArchive = await reserve(linked.accessToken, {
			bytes: new Uint8Array([4]),
			idempotencyKey: "late-archive",
			logicalObjectKey: "claude/late.age",
			machineRemoteId,
			sweepId: "later-sweep",
		});
		expect(lateArchive.status).toBe(409);
		expect(await lateArchive.json()).toEqual({ error: "index_pending" });
		const firstIndexObject = await putObject(linked.account.id, machineRemoteId, "index.jsonl.age", firstIndexBytes);
		expect((await finalize(linked.accessToken, firstIndex.reservationId)).status).toBe(200);
		const closedSweepArchive = await reserve(linked.accessToken, {
			bytes: new Uint8Array([4]),
			idempotencyKey: "closed-sweep-archive",
			logicalObjectKey: "claude/closed.age",
			machineRemoteId,
			sweepId: firstSweepId,
		});
		expect(closedSweepArchive.status).toBe(409);
		expect(await closedSweepArchive.json()).toEqual({ error: "sweep_closed" });

		const stale = await reserve(linked.accessToken, {
			bytes: new Uint8Array([3]),
			expectedArchiveCount: 0,
			expectedIndexEtag: "stale-etag",
			idempotencyKey: "stale-index",
			logicalObjectKey: "index.jsonl.age",
			machineRemoteId,
			sweepId: "stale-index-sweep",
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ error: "index_conflict" });

		const secondIndexResponse = await reserve(linked.accessToken, {
			bytes: new Uint8Array([3]),
			expectedArchiveCount: 0,
			expectedIndexEtag: firstIndexObject.etag,
			idempotencyKey: "second-index",
			logicalObjectKey: "index.jsonl.age",
			machineRemoteId,
			sweepId: "second-index-sweep",
		});
		expect(secondIndexResponse.status).toBe(201);
		const secondIndex = (await secondIndexResponse.json()) as ReservationResponse;
		expect(secondIndex.upload.headers["If-Match"]).toBe(`"${firstIndexObject.etag}"`);
		expect(new URL(secondIndex.upload.url).searchParams.get("X-Amz-SignedHeaders")).toContain("if-match");
		const secondIndexObject = await putObject(
			linked.account.id,
			machineRemoteId,
			"index.jsonl.age",
			new Uint8Array([3]),
		);
		expect((await finalize(linked.accessToken, secondIndex.reservationId)).status).toBe(200);
		const nextIndexResponse = await reserve(linked.accessToken, {
			bytes: new Uint8Array([4]),
			expectedArchiveCount: 0,
			expectedIndexEtag: secondIndexObject.etag,
			idempotencyKey: "next-index",
			logicalObjectKey: "index.jsonl.age",
			machineRemoteId,
			sweepId: "next-index-sweep",
		});
		expect(nextIndexResponse.status).toBe(201);
		expect(((await nextIndexResponse.json()) as ReservationResponse).upload.headers["If-Match"]).toBe(
			`"${secondIndexObject.etag}"`,
		);
	});
});

describe("tenant isolation", () => {
	it("never resolves another account's reservation or object", async () => {
		mockGitHubUsers({
			"github-one": { id: 1, login: "one" },
			"github-two": { id: 2, login: "two" },
		});
		const first = await exchange("github-one");
		const second = await exchange("github-two");
		const machineRemoteId = await createMachine(first.accessToken);
		const bytes = new Uint8Array([1, 2, 3]);
		const reservationResponse = await reserve(first.accessToken, {
			bytes,
			idempotencyKey: "tenant-object",
			logicalObjectKey: "gemini/session.age",
			machineRemoteId,
		});
		const reservation = (await reservationResponse.json()) as ReservationResponse;
		await putObject(first.account.id, machineRemoteId, "gemini/session.age", bytes);

		const otherFinalize = await finalize(second.accessToken, reservation.reservationId);
		expect(otherFinalize.status).toBe(404);
		expect(await otherFinalize.json()).toEqual({ error: "reservation_not_found" });
		expect((await finalize(first.accessToken, reservation.reservationId)).status).toBe(200);

		const otherDownload = await exports.default.fetch(
			jsonRequest("/v1/downloads", { logicalObjectKey: "gemini/session.age", machineRemoteId }, second.accessToken),
		);
		expect(otherDownload.status).toBe(404);
		expect(await otherDownload.json()).toEqual({ error: "object_not_found" });
	});
});
