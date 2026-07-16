import { z } from "zod";
import { STRIPE_SUBSCRIPTION_STATUSES } from "../db/schema.js";
import { logOperationalEvent } from "../operations/log.js";
import { type BillingBindings, BillingError } from "./model.js";
import { STRIPE_API_VERSION, verifyStripeSignature } from "./stripe.js";

const GRACE_SECONDS = 90 * 24 * 60 * 60;
const stripeIdSchema = z.string().regex(/^[A-Za-z]+_[A-Za-z0-9_]+$/u);
const subscriptionStatusSchema = z.enum(STRIPE_SUBSCRIPTION_STATUSES);
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
	if (priceId !== env.STRIPE_MONTHLY_PRICE_ID && priceId !== env.STRIPE_ANNUAL_PRICE_ID) {
		logOperationalEvent({
			accountId: customer.userId,
			event: "billing_event_rejected",
			now,
			reason: "invalid_price",
			severity: "error",
		});
		return;
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
			ON CONFLICT (user_id) DO UPDATE SET
				provider_subscription_id = excluded.provider_subscription_id,
				provider_customer_id = excluded.provider_customer_id,
				price_id = excluded.price_id,
				status = excluded.status,
				provider_event_created_at = excluded.provider_event_created_at,
				updated_at = excluded.updated_at
			WHERE (
				excluded.provider_subscription_id = billing_subscriptions.provider_subscription_id
				AND (
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
					)
				)
			) OR (
				excluded.provider_subscription_id <> billing_subscriptions.provider_subscription_id
				AND excluded.provider_event_created_at > billing_subscriptions.provider_event_created_at
				AND billing_subscriptions.status NOT IN ('incomplete', 'trialing', 'active')
				AND excluded.status IN ('incomplete', 'active')
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
		env.DB.prepare(
			`DELETE FROM billing_checkout_admissions
			WHERE user_id = ? AND ? IN ('active', 'incomplete_expired', 'canceled')
				AND EXISTS (
					SELECT 1 FROM billing_subscriptions s
					WHERE s.user_id = ? AND s.provider_subscription_id = ? AND s.status = ?
				)
				AND EXISTS (
					SELECT 1 FROM stripe_webhook_events WHERE id = ? AND processed_at IS NULL
				)`,
		).bind(customer.userId, subscription.status, customer.userId, subscription.id, subscription.status, event.id),
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
