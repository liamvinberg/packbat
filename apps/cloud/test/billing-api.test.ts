import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { deliverStripeEvent, stripeSignature, subscriptionEvent } from "./helpers/stripe.js";

interface LinkedAccount {
	accessToken: string;
	account: {
		graceEndsAt: string | null;
		id: string;
		subscriptionState: "active" | "grace" | "inactive";
	};
}

interface StripeRequestRecord {
	headers: Headers;
	parameters: URLSearchParams;
	path: string;
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

function installProviderFake(records: StripeRequestRecord[]): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		if (request.url === "https://api.github.com/user") {
			return Response.json({ id: 42_424, login: "octocat" });
		}
		const url = new URL(request.url);
		if (url.origin !== "https://api.stripe.com") {
			throw new Error(`Unexpected provider request: ${request.url}`);
		}
		const parameters = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
		records.push({ headers: request.headers, parameters, path: url.pathname });
		if (url.pathname === "/v1/customers") {
			return Response.json({ id: "cus_packbat" });
		}
		if (url.pathname === "/v1/checkout/sessions") {
			return Response.json({ id: "cs_test_packbat", url: "https://checkout.stripe.com/c/pay/packbat" });
		}
		if (url.pathname === "/v1/billing_portal/sessions") {
			return Response.json({ id: "bps_test_packbat", url: "https://billing.stripe.com/p/session/packbat" });
		}
		throw new Error(`Unexpected Stripe request: ${url.pathname}`);
	});
}

async function exchange(): Promise<LinkedAccount> {
	const response = await exports.default.fetch(
		jsonRequest("/v1/auth/github/exchange", { githubAccessToken: "github-token" }),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as LinkedAccount;
}

async function checkout(accessToken: string, interval: "month" | "year" = "month"): Promise<Response> {
	return await exports.default.fetch(
		jsonRequest("/v1/billing/checkout", { idempotencyKey: `checkout-${interval}`, interval }, accessToken),
	);
}

async function status(accessToken: string): Promise<{
	billingStarted: boolean;
	canRestore: boolean;
	canUpload: boolean;
	graceEndsAt: string | null;
	state: "active" | "grace" | "inactive";
}> {
	const response = await exports.default.fetch("https://api.packbat.dev/v1/billing/status", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Awaited<ReturnType<typeof status>>;
}

describe("hosted billing", () => {
	it("creates billing state only when Checkout begins and returns hosted Checkout and Portal URLs", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();

		expect(linked.account).toMatchObject({ graceEndsAt: null, subscriptionState: "inactive" });
		expect(await status(linked.accessToken)).toMatchObject({
			billingStarted: false,
			canRestore: false,
			canUpload: false,
			state: "inactive",
		});
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM billing_customers").first()).toEqual({ count: 0 });

		const checkoutResponse = await checkout(linked.accessToken, "year");
		expect(checkoutResponse.status).toBe(201);
		expect(await checkoutResponse.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/packbat" });
		expect(await status(linked.accessToken)).toMatchObject({ billingStarted: true, state: "inactive" });
		expect(records.map(({ path }) => path)).toEqual(["/v1/customers", "/v1/checkout/sessions"]);

		const customer = records[0];
		expect(customer?.headers.get("Authorization")).toBe(`Bearer ${env.STRIPE_SECRET_KEY}`);
		expect(customer?.headers.get("Stripe-Version")).toBe("2026-02-25.clover");
		expect(customer?.headers.get("Idempotency-Key")).toBe(`packbat-customer-${linked.account.id}`);
		expect(customer?.parameters.get("metadata[packbat_user_id]")).toBe(linked.account.id);

		const session = records[1];
		expect(session?.headers.get("Idempotency-Key")).toBe(`packbat-checkout-${linked.account.id}-checkout-year`);
		expect(Object.fromEntries(session?.parameters ?? [])).toMatchObject({
			"automatic_tax[enabled]": "true",
			client_reference_id: linked.account.id,
			customer: "cus_packbat",
			expires_at: expect.stringMatching(/^\d+$/u),
			"line_items[0][price]": env.STRIPE_ANNUAL_PRICE_ID,
			"line_items[0][quantity]": "1",
			mode: "subscription",
			"subscription_data[metadata][packbat_user_id]": linked.account.id,
			"tax_id_collection[enabled]": "true",
		});
		expect(session?.parameters.has("subscription_data[trial_period_days]")).toBe(false);

		const portal = await exports.default.fetch(jsonRequest("/v1/billing/portal", {}, linked.accessToken));
		expect(portal.status).toBe(200);
		expect(await portal.json()).toEqual({ url: "https://billing.stripe.com/p/session/packbat" });
		expect(records.at(-1)?.parameters.get("customer")).toBe("cus_packbat");
	});

	it("admits one concurrent Checkout and releases its admission after a definitive validation rejection", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		const [monthly, annual] = await Promise.all([
			exports.default.fetch(
				jsonRequest(
					"/v1/billing/checkout",
					{ idempotencyKey: "concurrent-month", interval: "month" },
					linked.accessToken,
				),
			),
			exports.default.fetch(
				jsonRequest(
					"/v1/billing/checkout",
					{ idempotencyKey: "concurrent-year", interval: "year" },
					linked.accessToken,
				),
			),
		]);
		expect([monthly.status, annual.status].sort()).toEqual([201, 409]);
		const rejected = monthly.status === 409 ? monthly : annual;
		expect(await rejected.json()).toEqual({ error: "checkout_in_progress" });
		expect(records.filter(({ path }) => path === "/v1/customers")).toHaveLength(1);
		expect(records.filter(({ path }) => path === "/v1/checkout/sessions")).toHaveLength(1);
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM billing_checkout_admissions").first()).toEqual({
			count: 1,
		});
		await env.DB.prepare("UPDATE billing_checkout_admissions SET created_at = 0, expires_at = 1").run();
		const expiredRecovery = await exports.default.fetch(
			jsonRequest(
				"/v1/billing/checkout",
				{ idempotencyKey: "expired-admission", interval: "month" },
				linked.accessToken,
			),
		);
		expect(expiredRecovery.status).toBe(201);
		expect(records.filter(({ path }) => path === "/v1/checkout/sessions")).toHaveLength(2);

		await env.DB.prepare("DELETE FROM billing_checkout_admissions").run();
		vi.restoreAllMocks();
		let checkoutAttempts = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (request.url === "https://api.github.com/user") {
				return Response.json({ id: 42_424, login: "octocat" });
			}
			if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
				checkoutAttempts += 1;
				return checkoutAttempts === 1
					? Response.json({ error: { type: "invalid_request_error" } }, { status: 400 })
					: Response.json({ id: "cs_test_recovered", url: "https://checkout.stripe.com/c/pay/recovered" });
			}
			throw new Error(`Unexpected provider request: ${request.url}`);
		});
		const failed = await exports.default.fetch(
			jsonRequest(
				"/v1/billing/checkout",
				{ idempotencyKey: "provider-failure", interval: "month" },
				linked.accessToken,
			),
		);
		expect(failed.status).toBe(502);
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM billing_checkout_admissions").first()).toEqual({
			count: 0,
		});
		const recovered = await exports.default.fetch(
			jsonRequest("/v1/billing/checkout", { idempotencyKey: "provider-retry", interval: "year" }, linked.accessToken),
		);
		expect(recovered.status).toBe(201);
		expect(await recovered.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/recovered" });
	});

	it("re-enters Stripe only for an exact retry of the admitted Checkout", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		const request = { idempotencyKey: "lost-checkout-response", interval: "month" as const };
		const first = await exports.default.fetch(jsonRequest("/v1/billing/checkout", request, linked.accessToken));
		const retry = await exports.default.fetch(jsonRequest("/v1/billing/checkout", request, linked.accessToken));
		expect(first.status).toBe(201);
		expect(retry.status).toBe(201);
		expect(await retry.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/packbat" });
		const sessions = records.filter(({ path }) => path === "/v1/checkout/sessions");
		expect(sessions).toHaveLength(2);
		expect(sessions.map(({ headers }) => headers.get("Idempotency-Key"))).toEqual([
			`packbat-checkout-${linked.account.id}-lost-checkout-response`,
			`packbat-checkout-${linked.account.id}-lost-checkout-response`,
		]);

		const differentKey = await exports.default.fetch(
			jsonRequest(
				"/v1/billing/checkout",
				{ idempotencyKey: "different-checkout", interval: "month" },
				linked.accessToken,
			),
		);
		const differentInterval = await exports.default.fetch(
			jsonRequest(
				"/v1/billing/checkout",
				{ idempotencyKey: "lost-checkout-response", interval: "year" },
				linked.accessToken,
			),
		);
		expect(differentKey.status).toBe(409);
		expect(await differentKey.json()).toEqual({ error: "checkout_in_progress" });
		expect(differentInterval.status).toBe(409);
		expect(await differentInterval.json()).toEqual({ error: "checkout_in_progress" });
		expect(records.filter(({ path }) => path === "/v1/checkout/sessions")).toHaveLength(2);
	});

	it("keeps a shared admission when an exact concurrent retry has an uncertain failure", async () => {
		const initialRecords: StripeRequestRecord[] = [];
		installProviderFake(initialRecords);
		const linked = await exchange();
		vi.restoreAllMocks();
		let sessionAttempts = 0;
		let markSecondSessionStarted: (() => void) | undefined;
		const secondSessionStarted = new Promise<void>((resolve) => {
			markSecondSessionStarted = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const providerRequest = new Request(input, init);
			if (providerRequest.url === "https://api.stripe.com/v1/customers") {
				return Response.json({ id: "cus_packbat" });
			}
			if (providerRequest.url !== "https://api.stripe.com/v1/checkout/sessions") {
				throw new Error(`Unexpected provider request: ${providerRequest.url}`);
			}
			sessionAttempts += 1;
			if (sessionAttempts === 1) {
				await secondSessionStarted;
				return Response.json({ id: "cs_test_shared", url: "https://checkout.stripe.com/c/pay/shared" });
			}
			if (sessionAttempts === 2) {
				markSecondSessionStarted?.();
				throw new TypeError("Stripe response was lost");
			}
			if (sessionAttempts === 3) {
				return Response.json({ error: { type: "idempotency_error" } }, { status: 409 });
			}
			return Response.json({ id: "cs_test_shared", url: "https://checkout.stripe.com/c/pay/shared" });
		});

		const exactRequest = { idempotencyKey: "shared-checkout", interval: "month" as const };
		const [first, uncertainRetry] = await Promise.all([
			exports.default.fetch(jsonRequest("/v1/billing/checkout", exactRequest, linked.accessToken)),
			exports.default.fetch(jsonRequest("/v1/billing/checkout", exactRequest, linked.accessToken)),
		]);
		expect([first.status, uncertainRetry.status].sort()).toEqual([201, 502]);
		expect(
			await env.DB.prepare("SELECT idempotency_key, interval FROM billing_checkout_admissions WHERE user_id = ?")
				.bind(linked.account.id)
				.first(),
		).toEqual({ idempotency_key: "shared-checkout", interval: "month" });

		const differentKey = await exports.default.fetch(
			jsonRequest("/v1/billing/checkout", { idempotencyKey: "not-shared", interval: "month" }, linked.accessToken),
		);
		expect(differentKey.status).toBe(409);
		expect(await differentKey.json()).toEqual({ error: "checkout_in_progress" });
		const providerConflict = await exports.default.fetch(
			jsonRequest("/v1/billing/checkout", exactRequest, linked.accessToken),
		);
		expect(providerConflict.status).toBe(502);
		expect(
			await env.DB.prepare("SELECT idempotency_key FROM billing_checkout_admissions WHERE user_id = ?")
				.bind(linked.account.id)
				.first(),
		).toEqual({ idempotency_key: "shared-checkout" });
		const blockedAfterConflict = await exports.default.fetch(
			jsonRequest(
				"/v1/billing/checkout",
				{ idempotencyKey: "still-not-shared", interval: "month" },
				linked.accessToken,
			),
		);
		expect(blockedAfterConflict.status).toBe(409);
		expect(await blockedAfterConflict.json()).toEqual({ error: "checkout_in_progress" });
		const recovered = await exports.default.fetch(
			jsonRequest("/v1/billing/checkout", exactRequest, linked.accessToken),
		);
		expect(recovered.status).toBe(201);
		expect(await recovered.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/shared" });
		expect(sessionAttempts).toBe(4);
	});

	it("keeps one current provider subscription while allowing resubscription from grace", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		expect((await checkout(linked.accessToken)).status).toBe(201);
		const currentTime = Math.floor(Date.now() / 1_000);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime,
						customerId: "cus_packbat",
						eventId: "evt_first_active",
						status: "active",
						subscriptionId: "sub_first",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime + 1,
						customerId: "cus_packbat",
						eventId: "evt_second_while_active",
						status: "active",
						subscriptionId: "sub_second",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect(await env.DB.prepare("SELECT provider_subscription_id FROM billing_subscriptions").first()).toEqual({
			provider_subscription_id: "sub_first",
		});

		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime + 2,
						customerId: "cus_packbat",
						eventId: "evt_first_lapsed",
						status: "canceled",
						subscriptionId: "sub_first",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect((await status(linked.accessToken)).state).toBe("grace");
		expect(
			(
				await exports.default.fetch(
					jsonRequest(
						"/v1/billing/checkout",
						{ idempotencyKey: "grace-resubscribe", interval: "year" },
						linked.accessToken,
					),
				)
			).status,
		).toBe(201);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime + 3,
						customerId: "cus_packbat",
						eventId: "evt_resubscribed",
						status: "active",
						subscriptionId: "sub_resubscribed",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect(await env.DB.prepare("SELECT provider_subscription_id FROM billing_subscriptions").all()).toMatchObject({
			results: [{ provider_subscription_id: "sub_resubscribed" }],
		});
		expect(await status(linked.accessToken)).toMatchObject({ graceEndsAt: null, state: "active" });
	});

	it("keeps an expired-grace account while an admitted resubscription waits for its webhook", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		expect((await checkout(linked.accessToken)).status).toBe(201);
		const currentTime = Math.floor(Date.now() / 1_000);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime,
						customerId: "cus_packbat",
						eventId: "evt_guard_active",
						status: "active",
						subscriptionId: "sub_guard_original",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime + 1,
						customerId: "cus_packbat",
						eventId: "evt_guard_lapsed",
						status: "canceled",
						subscriptionId: "sub_guard_original",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		const resubscribe = await exports.default.fetch(
			jsonRequest(
				"/v1/billing/checkout",
				{ idempotencyKey: "guarded-resubscribe", interval: "year" },
				linked.accessToken,
			),
		);
		expect(resubscribe.status).toBe(201);
		expect(
			await env.DB.prepare("SELECT user_id FROM billing_checkout_admissions WHERE user_id = ?")
				.bind(linked.account.id)
				.first(),
		).not.toBeNull();
		await env.DB.prepare("UPDATE users SET grace_started_at = 0, grace_ends_at = 1 WHERE id = ?")
			.bind(linked.account.id)
			.run();

		await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
		expect(
			await env.DB.prepare("SELECT deletion_requested_at FROM users WHERE id = ?").bind(linked.account.id).first(),
		).toEqual({ deletion_requested_at: null });
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime + 2,
						customerId: "cus_packbat",
						eventId: "evt_guard_reactivated",
						status: "active",
						subscriptionId: "sub_guard_replacement",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect(await status(linked.accessToken)).toMatchObject({ graceEndsAt: null, state: "active" });
	});

	it("verifies, deduplicates, and orders subscription webhooks across lapse and reactivation", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		expect((await checkout(linked.accessToken)).status).toBe(201);
		const currentTime = Math.floor(Date.now() / 1_000);
		const incomplete = subscriptionEvent({
			created: currentTime,
			customerId: "cus_packbat",
			eventId: "evt_incomplete",
			status: "incomplete",
			subscriptionId: "sub_packbat",
			type: "customer.subscription.created",
			userId: linked.account.id,
		});
		const active = subscriptionEvent({
			created: currentTime,
			customerId: "cus_packbat",
			eventId: "evt_active",
			status: "active",
			subscriptionId: "sub_packbat",
			type: "customer.subscription.created",
			userId: linked.account.id,
		});

		const invalid = await exports.default.fetch("https://api.packbat.dev/v1/billing/webhook", {
			body: active,
			headers: { "Stripe-Signature": "t=1,v1=invalid" },
			method: "POST",
		});
		expect(invalid.status).toBe(400);
		expect((await status(linked.accessToken)).state).toBe("inactive");

		expect((await deliverStripeEvent(incomplete, currentTime)).status).toBe(200);
		expect((await status(linked.accessToken)).state).toBe("inactive");
		await env.DB.prepare("UPDATE billing_checkout_admissions SET created_at = 0, expires_at = 1").run();
		const duplicatePendingSubscription = await checkout(linked.accessToken, "year");
		expect(duplicatePendingSubscription.status).toBe(409);
		expect(await duplicatePendingSubscription.json()).toEqual({ error: "subscription_pending" });
		expect((await deliverStripeEvent(active, currentTime)).status).toBe(200);
		expect((await deliverStripeEvent(active, currentTime)).status).toBe(200);
		expect(await status(linked.accessToken)).toMatchObject({ canRestore: true, canUpload: true, state: "active" });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_webhook_events").first()).toEqual({ count: 2 });

		const lapsed = subscriptionEvent({
			created: currentTime + 1,
			customerId: "cus_packbat",
			eventId: "evt_lapsed",
			status: "past_due",
			subscriptionId: "sub_packbat",
			userId: linked.account.id,
		});
		expect((await deliverStripeEvent(lapsed, currentTime)).status).toBe(200);
		const grace = await status(linked.accessToken);
		expect(grace).toMatchObject({ canRestore: true, canUpload: false, state: "grace" });
		expect(Date.parse(grace.graceEndsAt ?? "") - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1_000);

		const machine = await exports.default.fetch(jsonRequest("/v1/machines", {}, linked.accessToken));
		expect(machine.status).toBe(402);
		expect(await machine.json()).toEqual({ error: "subscription_required" });
		const ambiguousSameSecondActivation = subscriptionEvent({
			created: currentTime + 1,
			customerId: "cus_packbat",
			eventId: "evt_same_second_active",
			status: "active",
			subscriptionId: "sub_packbat",
			userId: linked.account.id,
		});
		expect((await deliverStripeEvent(ambiguousSameSecondActivation, currentTime)).status).toBe(200);
		expect((await status(linked.accessToken)).state).toBe("grace");

		const reactivated = subscriptionEvent({
			created: currentTime + 2,
			customerId: "cus_packbat",
			eventId: "evt_reactivated",
			status: "active",
			subscriptionId: "sub_packbat",
			userId: linked.account.id,
		});
		expect((await deliverStripeEvent(reactivated, currentTime)).status).toBe(200);
		expect(await status(linked.accessToken)).toMatchObject({ graceEndsAt: null, state: "active" });

		const delayedOldEvent = subscriptionEvent({
			created: currentTime + 1,
			customerId: "cus_packbat",
			eventId: "evt_delayed_old",
			status: "past_due",
			subscriptionId: "sub_packbat",
			userId: linked.account.id,
		});
		expect((await deliverStripeEvent(delayedOldEvent, currentTime)).status).toBe(200);
		expect((await status(linked.accessToken)).state).toBe("active");
	});

	it("reuses the account deletion cascade when grace expires", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		expect((await checkout(linked.accessToken)).status).toBe(201);
		const currentTime = Math.floor(Date.now() / 1_000);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime,
						customerId: "cus_packbat",
						eventId: "evt_delete_active",
						status: "active",
						subscriptionId: "sub_delete",
						type: "customer.subscription.created",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);
		expect(
			(
				await deliverStripeEvent(
					subscriptionEvent({
						created: currentTime + 1,
						customerId: "cus_packbat",
						eventId: "evt_delete_lapsed",
						status: "canceled",
						subscriptionId: "sub_delete",
						type: "customer.subscription.deleted",
						userId: linked.account.id,
					}),
					currentTime,
				)
			).status,
		).toBe(200);

		await env.DB.prepare(
			"UPDATE users SET grace_started_at = 0, grace_ends_at = 1 WHERE id = ? AND subscription_state = 'grace'",
		)
			.bind(linked.account.id)
			.run();
		await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);

		expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(linked.account.id).first()).toBeNull();
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM billing_customers").first()).toEqual({ count: 0 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM billing_subscriptions").first()).toEqual({ count: 0 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_webhook_events").first()).toEqual({ count: 0 });
	});

	it("rejects old signed payloads and valid subscriptions at an unknown price", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		expect((await checkout(linked.accessToken)).status).toBe(201);
		const currentTime = Math.floor(Date.now() / 1_000);
		const unknownPrice = subscriptionEvent({
			created: currentTime,
			customerId: "cus_packbat",
			eventId: "evt_unknown_price",
			priceId: "price_unknown",
			status: "active",
			subscriptionId: "sub_unknown_price",
			userId: linked.account.id,
		});
		expect((await deliverStripeEvent(unknownPrice, currentTime)).status).toBe(200);
		expect((await status(linked.accessToken)).state).toBe("inactive");

		const oldTimestamp = currentTime - 301;
		const old = await exports.default.fetch("https://api.packbat.dev/v1/billing/webhook", {
			body: unknownPrice,
			headers: { "Stripe-Signature": await stripeSignature(unknownPrice, oldTimestamp) },
			method: "POST",
		});
		expect(old.status).toBe(400);
	});

	it("limits billing and download authority independently per account", async () => {
		const records: StripeRequestRecord[] = [];
		installProviderFake(records);
		const linked = await exchange();
		const billingStatuses: number[] = [];
		for (let index = 0; index < 11; index += 1) {
			billingStatuses.push(
				(await exports.default.fetch(jsonRequest("/v1/billing/portal", {}, linked.accessToken))).status,
			);
		}
		expect(billingStatuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 404));
		expect(billingStatuses.at(-1)).toBe(429);

		const downloadStatuses: number[] = [];
		for (let index = 0; index < 121; index += 1) {
			downloadStatuses.push(
				(
					await exports.default.fetch(
						jsonRequest(
							"/v1/downloads",
							{ logicalObjectKey: "codex/missing.age", machineRemoteId: "abcdefghijklmnopqrstuvwx" },
							linked.accessToken,
						),
					)
				).status,
			);
		}
		expect(downloadStatuses.slice(0, 120)).toEqual(Array.from({ length: 120 }, () => 404));
		expect(downloadStatuses.at(-1)).toBe(429);
	});
});
