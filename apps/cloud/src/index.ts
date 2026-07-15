import { createApp } from "./app.js";
import { reconcileExpiredUploads, type StorageBindings } from "./storage/broker.js";

const app = createApp();

export default {
	fetch: app.fetch.bind(app),
	async scheduled(controller, env) {
		await reconcileExpiredUploads(env, Math.floor(controller.scheduledTime / 1_000));
	},
} satisfies ExportedHandler<StorageBindings>;
