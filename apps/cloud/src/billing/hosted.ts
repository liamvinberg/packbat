import { z } from "zod";
import {
	type BillingBindings,
	type BillingCustomer,
	BillingError,
	billingAccount,
	currentBillingCustomer,
} from "./model.js";
import { StripeRequestError, stripeRequest } from "./stripe.js";

const CHECKOUT_LIFETIME_SECONDS = 31 * 60;
const stripeIdSchema = z.string().regex(/^[A-Za-z]+_[A-Za-z0-9_]+$/u);
const customerSchema = z.object({ id: stripeIdSchema });
const sessionSchema = z.object({ id: stripeIdSchema, url: z.url() });

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

async function admitCheckout(
	env: BillingBindings,
	userId: string,
	interval: "month" | "year",
	idempotencyKey: string,
	now: number,
): Promise<number> {
	const expiresAt = now + CHECKOUT_LIFETIME_SECONDS;
	const admission = await env.DB.prepare(
		`INSERT INTO billing_checkout_admissions (user_id, idempotency_key, interval, created_at, expires_at)
		SELECT u.id, ?, ?, ?, ? FROM users u
		WHERE u.id = ? AND u.deletion_requested_at IS NULL AND u.subscription_state <> 'active'
			AND NOT EXISTS (
				SELECT 1 FROM billing_subscriptions s
				WHERE s.user_id = u.id AND s.status IN ('incomplete', 'trialing', 'active')
			)
		ON CONFLICT (user_id) DO UPDATE SET
			idempotency_key = excluded.idempotency_key,
			interval = excluded.interval,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at
		WHERE billing_checkout_admissions.expires_at <= ?
		RETURNING user_id AS userId`,
	)
		.bind(idempotencyKey, interval, now, expiresAt, userId, now)
		.first<{ userId: string }>();
	if (admission !== null) {
		return expiresAt;
	}

	const account = await billingAccount(env.DB, userId);
	if (account.deletionRequestedAt !== null) {
		throw new BillingError(409, "account_deleting");
	}
	if (account.state === "active") {
		throw new BillingError(409, "subscription_active");
	}
	const subscription = await env.DB.prepare(
		"SELECT status FROM billing_subscriptions WHERE user_id = ? AND status IN ('incomplete', 'trialing', 'active')",
	)
		.bind(userId)
		.first<{ status: string }>();
	if (subscription !== null) {
		throw new BillingError(409, "subscription_pending");
	}
	throw new BillingError(409, "checkout_in_progress");
}

async function releaseCheckoutAdmission(env: BillingBindings, userId: string, idempotencyKey: string): Promise<void> {
	await env.DB.prepare("DELETE FROM billing_checkout_admissions WHERE user_id = ? AND idempotency_key = ?")
		.bind(userId, idempotencyKey)
		.run();
}

export async function createCheckout(
	env: BillingBindings,
	userId: string,
	interval: "month" | "year",
	idempotencyKey: string,
	now: number,
): Promise<{ url: string }> {
	const expiresAt = await admitCheckout(env, userId, interval, idempotencyKey, now);
	try {
		const customer = await ensureBillingCustomer(env, userId, now);
		const priceId = interval === "month" ? env.STRIPE_MONTHLY_PRICE_ID : env.STRIPE_ANNUAL_PRICE_ID;
		const parameters = new URLSearchParams({
			"automatic_tax[enabled]": "true",
			cancel_url: env.STRIPE_CHECKOUT_CANCEL_URL,
			client_reference_id: userId,
			customer: customer.providerCustomerId,
			"customer_update[address]": "auto",
			"customer_update[name]": "auto",
			expires_at: String(expiresAt),
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
	} catch (error) {
		await releaseCheckoutAdmission(env, userId, idempotencyKey);
		throw error;
	}
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
