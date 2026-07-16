export const STRIPE_API_VERSION = "2026-02-25.clover";
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface StripeBindings {
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
}

export class StripeRequestError extends Error {
	constructor(readonly status: number) {
		super("stripe_request_failed");
	}
}

export async function stripeRequest(
	env: StripeBindings,
	path: string,
	parameters: URLSearchParams,
	idempotencyKey?: string,
): Promise<unknown> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
		"Content-Type": "application/x-www-form-urlencoded",
		"Stripe-Version": STRIPE_API_VERSION,
	};
	if (idempotencyKey !== undefined) {
		headers["Idempotency-Key"] = idempotencyKey;
	}
	const response = await fetch(`https://api.stripe.com${path}`, {
		body: parameters.toString(),
		headers,
		method: "POST",
	});
	if (!response.ok) {
		throw new StripeRequestError(response.status);
	}
	return await response.json();
}

function hexBytes(value: string): Uint8Array | null {
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		return null;
	}
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

export async function verifyStripeSignature(
	payload: string,
	header: string | null,
	secret: string,
	now: number,
): Promise<boolean> {
	if (header === null) {
		return false;
	}
	let timestamp: number | null = null;
	const signatures: Uint8Array[] = [];
	for (const rawItem of header.split(",")) {
		const item = rawItem.trim();
		const separator = item.indexOf("=");
		if (separator === -1) {
			continue;
		}
		const key = item.slice(0, separator);
		const value = item.slice(separator + 1);
		if (key === "t" && /^\d+$/u.test(value)) {
			timestamp = Number(value);
		}
		if (key === "v1") {
			const signature = hexBytes(value);
			if (signature !== null) {
				signatures.push(signature);
			}
		}
	}
	if (timestamp === null || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
		return false;
	}
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const expected = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
	);
	return signatures.some((signature) => equalBytes(expected, signature));
}
