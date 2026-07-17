import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(fileURLToPath(new URL("./drizzle", import.meta.url)));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						ACCESS_TOKEN_SECRET: "packbat-test-signing-secret-32-bytes-minimum",
						GITHUB_CLIENT_ID: "Ov23liPackbatCloudTest",
						R2_ACCESS_KEY_ID: "test-r2-access-key",
						R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
						R2_BUCKET_NAME: "packbat",
						R2_SECRET_ACCESS_KEY: "test-r2-secret-access-key",
						STORAGE_ALERT_BYTES: "1000000000000",
						STRIPE_ANNUAL_PRICE_ID: "price_packbat_annual",
						STRIPE_CHECKOUT_CANCEL_URL: "https://packbat.dev/cloud/checkout/cancel",
						STRIPE_CHECKOUT_SUCCESS_URL: "https://packbat.dev/cloud/checkout/success",
						STRIPE_LIVEMODE: "false",
						STRIPE_MONTHLY_PRICE_ID: "price_packbat_monthly",
						STRIPE_PORTAL_RETURN_URL: "https://packbat.dev",
						STRIPE_SECRET_KEY: "sk_test_packbat",
						STRIPE_WEBHOOK_SECRET: "whsec_packbat_test",
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
		test: {
			include: ["src/**/*.test.ts", "test/**/*.test.ts"],
			setupFiles: ["./test/setup.ts"],
		},
	};
});
