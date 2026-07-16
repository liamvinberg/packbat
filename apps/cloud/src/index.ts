import { createApp } from "./app.js";
import { reconcileBillingLifecycle } from "./billing/lifecycle.js";
import type { BillingBindings } from "./billing/model.js";
import { reconcileExpiredUploads, reconcileUsageAccounting, type StorageBindings } from "./storage/broker.js";

const app = createApp();

export default {
	fetch: app.fetch.bind(app),
	async scheduled(controller, env) {
		const now = Math.floor(controller.scheduledTime / 1_000);
		await reconcileExpiredUploads(env, now);
		await reconcileUsageAccounting(env.DB, now);
		await reconcileBillingLifecycle(env, now);
	},
} satisfies ExportedHandler<StorageBindings & BillingBindings>;
