export type OperationalEvent =
	| "accounting_reconciled"
	| "billing_event_rejected"
	| "grace_deletion_failed"
	| "quota_exceeded"
	| "rate_limited"
	| "storage_cost_threshold"
	| "webhook_rejected";

export type OperationalReason =
	| "accounting_drift"
	| "api_requests"
	| "billing_customer_mismatch"
	| "billing_requests"
	| "deletion_error"
	| "download_requests"
	| "invalid_price"
	| "invalid_signature"
	| "invalid_subscription"
	| "storage_bytes";

interface OperationalLog {
	accountId?: string;
	event: OperationalEvent;
	limit?: number;
	occurredAt: string;
	reason: OperationalReason;
	severity: "warning" | "error";
}

export function logOperationalEvent(input: {
	accountId?: string;
	event: OperationalEvent;
	limit?: number;
	now: number;
	reason: OperationalReason;
	severity?: "warning" | "error";
}): void {
	const entry: OperationalLog = {
		event: input.event,
		occurredAt: new Date(input.now * 1_000).toISOString(),
		reason: input.reason,
		severity: input.severity ?? "warning",
		...(input.accountId === undefined ? {} : { accountId: input.accountId }),
		...(input.limit === undefined ? {} : { limit: input.limit }),
	};
	console.warn(JSON.stringify(entry));
}

export async function logAccountOperationalEventOnce(
	binding: D1Database,
	input: Parameters<typeof logOperationalEvent>[0] & { accountId: string },
	minimumIntervalSeconds = 5 * 60,
): Promise<void> {
	const key = `${input.event}:${input.reason}:${input.accountId}`;
	const result = await binding
		.prepare(
			`INSERT INTO service_alerts (key, user_id, last_emitted_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET last_emitted_at = excluded.last_emitted_at
			WHERE service_alerts.last_emitted_at <= ?`,
		)
		.bind(key, input.accountId, input.now, input.now - minimumIntervalSeconds)
		.run();
	if ((result.meta.changes ?? 0) === 1) {
		logOperationalEvent(input);
	}
}
