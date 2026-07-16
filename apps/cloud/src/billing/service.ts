import { z } from "zod";
import { logOperationalEvent } from "../operations/log.js";
import { deleteAccountData, type StorageBindings } from "../storage/broker.js";
import {
	STRIPE_API_VERSION,
	type StripeBindings,
	StripeRequestError,
	stripeRequest,
	verifyStripeSignature,
} from "./stripe.js";

const GRACE_SECONDS = 90 * 24 * 60 * 60;
const WEBHOOK_EVENT_RETENTION_SECONDS = 31 * 24 * 60 * 60;
const ALERT_REPEAT_SECONDS = 24 * 60 * 60;
const GRACE_DELETION_BATCH_SIZE = 25;

const stripeIdSchema = z.string().regex(/^[A-Za-z]+_[A-Za-z0-9_]+$/u);
const customerSchema = z.object({ id: stripeIdSchema });
const sessionSchema = z.object({ id: stripeIdSchema, url: z.url() });
const subscriptionStatusSchema = z.enum([
	"incomplete",
	"incomplete_expired",
	"trialing",
	"active",
	"past_due",
	"canceled",
	"unpaid",
	"paused",
]);
const subscriptionSchema = z.object({
	id: stripeIdSchema,
	customer: stripeIdSchema,
	items: z.object({
		data: z.array(
			z.object({
				price: z.object({ id: stripeIdSchema }),
				quantity: z.number().int().nullable(),
			}),
		),
	}),
	metadata: z.record(z.string(), z.string()),
	status: subscriptionStatusSchema,
});
const eventSchema = z.object({
	api_version: z.literal(STRIPE_API_VERSION),
	created: z.number().int().nonnegative().safe(),
	data: z.object({ object: z.unknown() }),
	id: z.string().regex(/^evt_[A-Za-z0-9_]+$/u),
	livemode: z.boolean(),
	object: z.literal("event"),
	type: z.string(),
});

export interface BillingBindings extends StripeBindings {
	DB: D1Database;
	STORAGE_ALERT_BYTES: string;
	STRIPE_ANNUAL_PRICE_ID: string;
	STRIPE_CHECKOUT_CANCEL_URL: string;
	STRIPE_CHECKOUT_SUCCESS_URL: string;
	STRIPE_LIVEMODE: string;
	STRIPE_MONTHLY_PRICE_ID: string;
	STRIPE_PORTAL_RETURN_URL: string;
}

export class BillingError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 502,
		readonly code: string,
	) {
		super(code);
	}
}

interface BillingAccount {
	deletionRequestedAt: number | null;
	graceEndsAt: number | null;
	id: string;
	quotaBytes: number;
	reservedBytes: number;
	state: "active" | "grace" | "inactive";
	usedBytes: number;
}

interface BillingCustomer {
	providerCustomerId: string;
}

function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new BillingError(502, "billing_provider_error");
	}
	return parsed.data;
}

async function requestStripe(
	env: BillingBindings,
	path: string,
	parameters: URLSearchParams,
	idempotencyKey?: string,
): Promise<unknown> {
	try {
		return await stripeRequest(env, path, parameters, idempotencyKey);
	} catch (error) {
		if (error instanceof StripeRequestError || error instanceof TypeError) {
			throw new BillingError(502, "billing_provider_error");
		}
		throw error;
	}
}

async function billingAccount(binding: D1Database, userId: string): Promise<BillingAccount> {
	const account = await binding
		.prepare(
			`SELECT
				deletion_requested_at AS deletionRequestedAt,
				grace_ends_at AS graceEndsAt,
				id,
				quota_bytes AS quotaBytes,
				reserved_bytes AS reservedBytes,
				subscription_state AS state,
				used_bytes AS usedBytes
			FROM users WHERE id = ?`,
		)
		.bind(userId)
		.first<BillingAccount>();
	if (account === null) {
		throw new BillingError(404, "account_not_found");
	}
	return account;
}

async function currentBillingCustomer(binding: D1Database, userId: string): Promise<BillingCustomer | null> {
	return await binding
		.prepare(
			`SELECT provider_customer_id AS providerCustomerId
			FROM billing_customers WHERE user_id = ? AND provider = 'stripe'`,
		)
		.bind(userId)
		.first<BillingCustomer>();
}

async function ensureBillingCustomer(env: BillingBindings, userId: string, now: number): Promise<BillingCustomer> {
	const existing = await currentBillingCustomer(env.DB, userId);
	if (existing !== null) {
		return existing;
	}
	const response = parseProviderResponse(
		customerSchema,
		await requestStripe(
			env,
			"/v1/customers",
			new URLSearchParams({ "metadata[packbat_user_id]": userId }),
			`packbat-customer-${userId}`,
		),
	);
	await env.DB.prepare(
		`INSERT INTO billing_customers (user_id, provider, provider_customer_id, created_at)
		SELECT id, 'stripe', ?, ? FROM users
		WHERE id = ? AND deletion_requested_at IS NULL
		ON CONFLICT (user_id) DO NOTHING`,
	)
		.bind(response.id, now, userId)
		.run();
	const stored = await currentBillingCustomer(env.DB, userId);
	if (stored === null || stored.providerCustomerId !== response.id) {
		throw new BillingError(409, "billing_customer_conflict");
	}
	return stored;
}

export async function createCheckout(
	env: BillingBindings,
	userId: string,
	interval: "month" | "year",
	idempotencyKey: string,
	now: number,
): Promise<{ url: string }> {
	const account = await billingAccount(env.DB, userId);
	if (account.deletionRequestedAt !== null) {
		throw new BillingError(409, "account_deleting");
	}
	if (account.state === "active") {
		throw new BillingError(409, "subscription_active");
	}
	const customer = await ensureBillingCustomer(env, userId, now);
	const priceId = interval === "month" ? env.STRIPE_MONTHLY_PRICE_ID : env.STRIPE_ANNUAL_PRICE_ID;
	const parameters = new URLSearchParams({
		"automatic_tax[enabled]": "true",
		cancel_url: env.STRIPE_CHECKOUT_CANCEL_URL,
		client_reference_id: userId,
		customer: customer.providerCustomerId,
		"customer_update[address]": "auto",
		"customer_update[name]": "auto",
		"line_items[0][price]": priceId,
		"line_items[0][quantity]": "1",
		mode: "subscription",
		"subscription_data[description]": "Packbat Cloud, 100 GB end-to-end encrypted archive storage",
		"subscription_data[metadata][packbat_user_id]": userId,
		success_url: env.STRIPE_CHECKOUT_SUCCESS_URL,
		"tax_id_collection[enabled]": "true",
	});
	const response = parseProviderResponse(
		sessionSchema,
		await requestStripe(env, "/v1/checkout/sessions", parameters, `packbat-checkout-${userId}-${idempotencyKey}`),
	);
	return { url: response.url };
}

export async function createPortal(env: BillingBindings, userId: string): Promise<{ url: string }> {
	const account = await billingAccount(env.DB, userId);
	if (account.deletionRequestedAt !== null) {
		throw new BillingError(409, "account_deleting");
	}
	const customer = await currentBillingCustomer(env.DB, userId);
	if (customer === null) {
		throw new BillingError(404, "billing_not_started");
	}
	const response = parseProviderResponse(
		sessionSchema,
		await requestStripe(
			env,
			"/v1/billing_portal/sessions",
			new URLSearchParams({ customer: customer.providerCustomerId, return_url: env.STRIPE_PORTAL_RETURN_URL }),
		),
	);
	return { url: response.url };
}

export async function billingStatus(env: BillingBindings, userId: string, now: number) {
	const account = await billingAccount(env.DB, userId);
	const customer = await currentBillingCustomer(env.DB, userId);
	const graceOpen = account.state === "grace" && account.graceEndsAt !== null && account.graceEndsAt > now;
	return {
		billingStarted: customer !== null,
		canRestore: account.deletionRequestedAt === null && (account.state === "active" || graceOpen),
		canUpload: account.deletionRequestedAt === null && account.state === "active",
		graceEndsAt: account.graceEndsAt === null ? null : new Date(account.graceEndsAt * 1_000).toISOString(),
		quotaBytes: account.quotaBytes,
		reservedBytes: account.reservedBytes,
		state: account.state,
		usedBytes: account.usedBytes,
	};
}

async function applySubscriptionEvent(
	env: BillingBindings,
	event: z.infer<typeof eventSchema>,
	subscription: z.infer<typeof subscriptionSchema>,
	now: number,
): Promise<void> {
	const customer = await env.DB.prepare(
		`SELECT user_id AS userId FROM billing_customers
		WHERE provider = 'stripe' AND provider_customer_id = ?`,
	)
		.bind(subscription.customer)
		.first<{ userId: string }>();
	if (customer === null || subscription.metadata.packbat_user_id !== customer.userId) {
		logOperationalEvent({
			event: "billing_event_rejected",
			now,
			reason: "billing_customer_mismatch",
			severity: "error",
		});
		return;
	}
	const singleItem = subscription.items.data.length === 1 ? subscription.items.data[0] : undefined;
	if (singleItem === undefined || singleItem.quantity !== 1) {
		logOperationalEvent({
			accountId: customer.userId,
			event: "billing_event_rejected",
			now,
			reason: "invalid_subscription",
			severity: "error",
		});
		return;
	}
	const priceId = singleItem.price.id;
	const validPrice = priceId === env.STRIPE_MONTHLY_PRICE_ID || priceId === env.STRIPE_ANNUAL_PRICE_ID;
	if (!validPrice) {
		logOperationalEvent({
			accountId: customer.userId,
			event: "billing_event_rejected",
			now,
			reason: "invalid_price",
			severity: "error",
		});
	}
	const processed = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO stripe_webhook_events (
				id, user_id, event_type, object_id, event_created_at, received_at, processed_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (id) DO NOTHING`,
		).bind(event.id, customer.userId, event.type, subscription.id, event.created, now),
		env.DB.prepare(
			`INSERT INTO billing_subscriptions (
				provider_subscription_id, user_id, provider_customer_id, price_id, status,
				provider_event_created_at, updated_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?
			WHERE EXISTS (
				SELECT 1 FROM stripe_webhook_events WHERE id = ? AND processed_at IS NULL
			)
			ON CONFLICT (provider_subscription_id) DO UPDATE SET
				user_id = excluded.user_id,
				provider_customer_id = excluded.provider_customer_id,
				price_id = excluded.price_id,
				status = excluded.status,
				provider_event_created_at = excluded.provider_event_created_at,
				updated_at = excluded.updated_at
			WHERE
				excluded.provider_event_created_at > billing_subscriptions.provider_event_created_at
				OR (
					excluded.provider_event_created_at = billing_subscriptions.provider_event_created_at
					AND billing_subscriptions.status = 'active'
					AND excluded.status <> 'active'
				)
				OR (
					excluded.provider_event_created_at = billing_subscriptions.provider_event_created_at
					AND billing_subscriptions.status = 'incomplete'
					AND excluded.status = 'active'
				)`,
		).bind(
			subscription.id,
			customer.userId,
			subscription.customer,
			priceId,
			subscription.status,
			event.created,
			now,
			event.id,
		),
		env.DB.prepare(
			`UPDATE users SET
				subscription_state = CASE
					WHEN EXISTS (
						SELECT 1 FROM billing_subscriptions s
						WHERE s.user_id = users.id AND s.status = 'active' AND s.price_id IN (?, ?)
					) THEN 'active'
					WHEN subscription_activated_at IS NULL THEN 'inactive'
					ELSE 'grace'
				END,
				subscription_activated_at = CASE
					WHEN EXISTS (
						SELECT 1 FROM billing_subscriptions s
						WHERE s.user_id = users.id AND s.status = 'active' AND s.price_id IN (?, ?)
					) THEN COALESCE(subscription_activated_at, ?)
					ELSE subscription_activated_at
				END,
				grace_started_at = CASE
					WHEN EXISTS (
						SELECT 1 FROM billing_subscriptions s
						WHERE s.user_id = users.id AND s.status = 'active' AND s.price_id IN (?, ?)
					) OR subscription_activated_at IS NULL THEN NULL
					WHEN subscription_state = 'grace' THEN grace_started_at
					ELSE ?
				END,
				grace_ends_at = CASE
					WHEN EXISTS (
						SELECT 1 FROM billing_subscriptions s
						WHERE s.user_id = users.id AND s.status = 'active' AND s.price_id IN (?, ?)
					) OR subscription_activated_at IS NULL THEN NULL
					WHEN subscription_state = 'grace' THEN grace_ends_at
					ELSE ?
				END
			WHERE id = ? AND deletion_requested_at IS NULL AND EXISTS (
				SELECT 1 FROM stripe_webhook_events WHERE id = ? AND processed_at IS NULL
			)`,
		).bind(
			env.STRIPE_MONTHLY_PRICE_ID,
			env.STRIPE_ANNUAL_PRICE_ID,
			env.STRIPE_MONTHLY_PRICE_ID,
			env.STRIPE_ANNUAL_PRICE_ID,
			event.created,
			env.STRIPE_MONTHLY_PRICE_ID,
			env.STRIPE_ANNUAL_PRICE_ID,
			event.created,
			env.STRIPE_MONTHLY_PRICE_ID,
			env.STRIPE_ANNUAL_PRICE_ID,
			event.created + GRACE_SECONDS,
			customer.userId,
			event.id,
		),
		env.DB.prepare("UPDATE stripe_webhook_events SET processed_at = ? WHERE id = ? AND processed_at IS NULL").bind(
			now,
			event.id,
		),
	]);
	if ((processed[0]?.meta.changes ?? 0) === 0) {
		return;
	}
}

export async function handleStripeWebhook(
	env: BillingBindings,
	payload: string,
	signature: string | null,
	now: number,
): Promise<void> {
	if (!(await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET, now))) {
		logOperationalEvent({ event: "webhook_rejected", now, reason: "invalid_signature", severity: "error" });
		throw new BillingError(400, "invalid_webhook_signature");
	}
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		throw new BillingError(400, "invalid_webhook_event");
	}
	const parsed = eventSchema.safeParse(value);
	if (!parsed.success || parsed.data.livemode !== (env.STRIPE_LIVEMODE === "true")) {
		throw new BillingError(400, "invalid_webhook_event");
	}
	if (
		!["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(
			parsed.data.type,
		)
	) {
		return;
	}
	const subscription = subscriptionSchema.safeParse(parsed.data.data.object);
	if (!subscription.success) {
		throw new BillingError(400, "invalid_webhook_event");
	}
	await applySubscriptionEvent(env, parsed.data, subscription.data, now);
}

async function processExpiredGraceAccounts(env: BillingBindings & StorageBindings, now: number): Promise<void> {
	const expired = await env.DB.prepare(
		`SELECT id FROM users
		WHERE subscription_state = 'grace' AND grace_ends_at <= ?
		ORDER BY grace_ends_at LIMIT ?`,
	)
		.bind(now, GRACE_DELETION_BATCH_SIZE)
		.all<{ id: string }>();
	for (const account of expired.results) {
		try {
			await deleteAccountData(env, account.id, now);
		} catch {
			logOperationalEvent({
				accountId: account.id,
				event: "grace_deletion_failed",
				now,
				reason: "deletion_error",
				severity: "error",
			});
		}
	}
}

async function checkStorageCostThreshold(env: BillingBindings, now: number): Promise<void> {
	const threshold = Number(env.STORAGE_ALERT_BYTES);
	if (!Number.isSafeInteger(threshold) || threshold <= 0) {
		throw new Error("STORAGE_ALERT_BYTES must be a positive safe integer");
	}
	const total = await env.DB.prepare("SELECT COALESCE(SUM(used_bytes + reserved_bytes), 0) AS bytes FROM users").first<{
		bytes: number;
	}>();
	if ((total?.bytes ?? 0) < threshold) {
		await env.DB.prepare("DELETE FROM service_alerts WHERE key = 'storage_cost_threshold'").run();
		return;
	}
	const result = await env.DB.prepare(
		`INSERT INTO service_alerts (key, last_emitted_at) VALUES ('storage_cost_threshold', ?)
		ON CONFLICT (key) DO UPDATE SET last_emitted_at = excluded.last_emitted_at
		WHERE service_alerts.last_emitted_at <= ?`,
	)
		.bind(now, now - ALERT_REPEAT_SECONDS)
		.run();
	if ((result.meta.changes ?? 0) === 1) {
		logOperationalEvent({
			event: "storage_cost_threshold",
			limit: threshold,
			now,
			reason: "storage_bytes",
		});
	}
}

export async function reconcileBillingLifecycle(env: BillingBindings & StorageBindings, now: number): Promise<void> {
	await processExpiredGraceAccounts(env, now);
	await env.DB.prepare("DELETE FROM stripe_webhook_events WHERE processed_at < ?")
		.bind(now - WEBHOOK_EVENT_RETENTION_SECONDS)
		.run();
	await env.DB.prepare("DELETE FROM service_alerts WHERE user_id IS NOT NULL AND last_emitted_at < ?")
		.bind(now - 60 * 60)
		.run();
	await checkStorageCostThreshold(env, now);
}
