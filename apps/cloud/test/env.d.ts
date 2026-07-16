declare namespace Cloudflare {
	interface Env {
		ACCESS_TOKEN_SECRET: string;
		AUTH_RATE_LIMITER: RateLimit;
		R2_ACCESS_KEY_ID: string;
		R2_ACCOUNT_ID: string;
		R2_BUCKET_NAME: string;
		R2_SECRET_ACCESS_KEY: string;
		STORAGE_ALERT_BYTES: string;
		STRIPE_ANNUAL_PRICE_ID: string;
		STRIPE_CHECKOUT_CANCEL_URL: string;
		STRIPE_CHECKOUT_SUCCESS_URL: string;
		STRIPE_LIVEMODE: string;
		STRIPE_MONTHLY_PRICE_ID: string;
		STRIPE_PORTAL_RETURN_URL: string;
		STRIPE_SECRET_KEY: string;
		STRIPE_WEBHOOK_SECRET: string;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}

	interface GlobalProps {
		mainModule: typeof import("../src/index.js");
	}
}
