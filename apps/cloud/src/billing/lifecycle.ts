import { logOperationalEvent } from "../operations/log.js";
import { deleteExpiredGraceAccountData, type StorageBindings } from "../storage/broker.js";
import type { BillingBindings } from "./model.js";

const WEBHOOK_EVENT_RETENTION_SECONDS = 31 * 24 * 60 * 60;
const ALERT_REPEAT_SECONDS = 24 * 60 * 60;
const GRACE_DELETION_BATCH_SIZE = 25;

async function processExpiredGraceAccounts(env: BillingBindings & StorageBindings, now: number): Promise<void> {
	const expired = await env.DB.prepare(
		`SELECT id FROM users
		WHERE subscription_state = 'grace' AND grace_ends_at <= ?
			AND NOT EXISTS (
				SELECT 1 FROM billing_checkout_admissions a
				WHERE a.user_id = users.id AND a.expires_at > ?
			)
		ORDER BY grace_ends_at LIMIT ?`,
	)
		.bind(now, now, GRACE_DELETION_BATCH_SIZE)
		.all<{ id: string }>();
	for (const account of expired.results) {
		try {
			await deleteExpiredGraceAccountData(env, account.id, now);
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
	await env.DB.prepare("DELETE FROM billing_checkout_admissions WHERE expires_at <= ?").bind(now).run();
	await env.DB.prepare("DELETE FROM stripe_webhook_events WHERE processed_at < ?")
		.bind(now - WEBHOOK_EVENT_RETENTION_SECONDS)
		.run();
	await env.DB.prepare("DELETE FROM service_alerts WHERE user_id IS NOT NULL AND last_emitted_at < ?")
		.bind(now - 60 * 60)
		.run();
	await checkStorageCostThreshold(env, now);
}
