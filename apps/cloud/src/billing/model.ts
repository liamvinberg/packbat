import type { StripeBindings } from "./stripe.js";

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

export interface BillingAccount {
	deletionRequestedAt: number | null;
	graceEndsAt: number | null;
	id: string;
	quotaBytes: number;
	reservedBytes: number;
	state: "active" | "grace" | "inactive";
	usedBytes: number;
}

export interface BillingCustomer {
	providerCustomerId: string;
}

export async function billingAccount(binding: D1Database, userId: string): Promise<BillingAccount> {
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

export async function currentBillingCustomer(binding: D1Database, userId: string): Promise<BillingCustomer | null> {
	return await binding
		.prepare(
			`SELECT provider_customer_id AS providerCustomerId
			FROM billing_customers WHERE user_id = ? AND provider = 'stripe'`,
		)
		.bind(userId)
		.first<BillingCustomer>();
}
