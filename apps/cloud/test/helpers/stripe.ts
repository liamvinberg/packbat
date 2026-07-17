import { env, exports } from "cloudflare:workers";

export const TEST_STRIPE_API_VERSION = "2026-06-24.dahlia";

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stripeSignature(payload: string, timestamp: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
	);
	return `t=${timestamp},v1=${bytesToHex(signature)}`;
}

export function subscriptionEvent(input: {
	created: number;
	customerId: string;
	eventId: string;
	priceId?: string;
	status: "active" | "canceled" | "incomplete" | "past_due";
	subscriptionId: string;
	type?: "customer.subscription.created" | "customer.subscription.deleted" | "customer.subscription.updated";
	userId: string;
}): string {
	return JSON.stringify({
		api_version: TEST_STRIPE_API_VERSION,
		created: input.created,
		data: {
			object: {
				customer: input.customerId,
				id: input.subscriptionId,
				items: { data: [{ price: { id: input.priceId ?? env.STRIPE_MONTHLY_PRICE_ID }, quantity: 1 }] },
				metadata: { packbat_user_id: input.userId },
				status: input.status,
			},
		},
		id: input.eventId,
		livemode: false,
		object: "event",
		type: input.type ?? "customer.subscription.updated",
	});
}

export async function deliverStripeEvent(
	payload: string,
	timestamp = Math.floor(Date.now() / 1_000),
): Promise<Response> {
	return await exports.default.fetch("https://api.packbat.dev/v1/billing/webhook", {
		body: payload,
		headers: { "Stripe-Signature": await stripeSignature(payload, timestamp) },
		method: "POST",
	});
}
