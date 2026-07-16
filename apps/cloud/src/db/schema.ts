import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const CLOUD_QUOTA_BYTES = 100_000_000_000;

export const SUBSCRIPTION_STATES = ["inactive", "active", "grace"] as const;
export const STRIPE_SUBSCRIPTION_STATUSES = [
	"incomplete",
	"incomplete_expired",
	"trialing",
	"active",
	"past_due",
	"canceled",
	"unpaid",
	"paused",
] as const;

export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		githubSubjectId: text("github_subject_id").notNull(),
		createdAt: integer("created_at").notNull(),
		quotaBytes: integer("quota_bytes").notNull(),
		usedBytes: integer("used_bytes").notNull(),
		reservedBytes: integer("reserved_bytes").notNull(),
		storagePrefix: text("storage_prefix").notNull(),
		subscriptionActivatedAt: integer("subscription_activated_at"),
		subscriptionState: text("subscription_state", { enum: SUBSCRIPTION_STATES }).notNull().default("inactive"),
		graceStartedAt: integer("grace_started_at"),
		graceEndsAt: integer("grace_ends_at"),
		deletionRequestedAt: integer("deletion_requested_at"),
		deleteAfter: integer("delete_after"),
	},
	(table) => [
		uniqueIndex("users_github_subject_id_unique").on(table.githubSubjectId),
		uniqueIndex("users_storage_prefix_unique").on(table.storagePrefix),
		check(
			"users_github_subject_id_numeric",
			sql`${table.githubSubjectId} <> '' AND ${table.githubSubjectId} NOT GLOB '*[^0-9]*'`,
		),
		check("users_quota_bytes_nonnegative", sql`${table.quotaBytes} >= 0`),
		check("users_used_bytes_nonnegative", sql`${table.usedBytes} >= 0`),
		check("users_reserved_bytes_nonnegative", sql`${table.reservedBytes} >= 0`),
		check("users_subscription_state_valid", sql`${table.subscriptionState} IN ('inactive', 'active', 'grace')`),
		check(
			"users_subscription_lifecycle_valid",
			sql`(
				${table.subscriptionState} = 'inactive'
				AND ${table.subscriptionActivatedAt} IS NULL
				AND ${table.graceStartedAt} IS NULL
				AND ${table.graceEndsAt} IS NULL
			) OR (
				${table.subscriptionState} = 'active'
				AND ${table.subscriptionActivatedAt} IS NOT NULL
				AND ${table.graceStartedAt} IS NULL
				AND ${table.graceEndsAt} IS NULL
			) OR (
				${table.subscriptionState} = 'grace'
				AND ${table.subscriptionActivatedAt} IS NOT NULL
				AND ${table.graceStartedAt} IS NOT NULL
				AND ${table.graceEndsAt} > ${table.graceStartedAt}
			)`,
		),
	],
);

export const cliCredentials = sqliteTable(
	"cli_credentials",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		refreshTokenDigest: text("refresh_token_digest").notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		revokedAt: integer("revoked_at"),
	},
	(table) => [
		index("cli_credentials_user_id_index").on(table.userId),
		check("cli_credentials_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
		check(
			"cli_credentials_revoked_after_creation",
			sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
		),
	],
);

export const machineRemotes = sqliteTable(
	"machine_remotes",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
		currentIndexEtag: text("current_index_etag"),
	},
	(table) => [
		index("machine_remotes_user_id_index").on(table.userId),
		uniqueIndex("machine_remotes_user_id_id_unique").on(table.userId, table.id),
	],
);

export const objectLedger = sqliteTable(
	"object_ledger",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		machineRemoteId: text("machine_remote_id").notNull(),
		logicalObjectKey: text("logical_object_key").notNull(),
		bytes: integer("bytes").notNull(),
		etag: text("etag").notNull(),
		lastCompletedAt: integer("last_completed_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.machineRemoteId, table.logicalObjectKey] }),
		index("object_ledger_user_id_index").on(table.userId),
		foreignKey({
			columns: [table.userId, table.machineRemoteId],
			foreignColumns: [machineRemotes.userId, machineRemotes.id],
		}).onDelete("cascade"),
		check("object_ledger_bytes_nonnegative", sql`${table.bytes} >= 0`),
	],
);

export const uploadReservations = sqliteTable(
	"upload_reservations",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		machineRemoteId: text("machine_remote_id").notNull(),
		logicalObjectKey: text("logical_object_key").notNull(),
		sweepId: text("sweep_id").notNull(),
		expectedArchiveCount: integer("expected_archive_count"),
		expectedBytes: integer("expected_bytes").notNull(),
		checksumSha256: text("checksum_sha256").notNull(),
		replacedBytes: integer("replaced_bytes").notNull(),
		replacedEtag: text("replaced_etag"),
		expectedIndexEtag: text("expected_index_etag"),
		idempotencyKey: text("idempotency_key").notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		writeFencedAt: integer("write_fenced_at"),
		state: text("state", { enum: ["pending", "completed", "expired"] }).notNull(),
	},
	(table) => [
		uniqueIndex("upload_reservations_user_id_idempotency_key_unique").on(table.userId, table.idempotencyKey),
		uniqueIndex("upload_reservations_sweep_object_unique").on(
			table.userId,
			table.machineRemoteId,
			table.sweepId,
			table.logicalObjectKey,
		),
		uniqueIndex("upload_reservations_pending_object_unique")
			.on(table.userId, table.machineRemoteId, table.logicalObjectKey)
			.where(sql`${table.state} = 'pending'`),
		index("upload_reservations_expiry_index").on(table.state, table.expiresAt),
		foreignKey({
			columns: [table.userId, table.machineRemoteId],
			foreignColumns: [machineRemotes.userId, machineRemotes.id],
		}).onDelete("cascade"),
		check("upload_reservations_expected_bytes_nonnegative", sql`${table.expectedBytes} >= 0`),
		check(
			"upload_reservations_expected_archive_count_nonnegative",
			sql`${table.expectedArchiveCount} IS NULL OR ${table.expectedArchiveCount} >= 0`,
		),
		check("upload_reservations_replaced_bytes_nonnegative", sql`${table.replacedBytes} >= 0`),
		check("upload_reservations_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
		check("upload_reservations_state_valid", sql`${table.state} IN ('pending', 'completed', 'expired')`),
	],
);

export const billingCustomers = sqliteTable(
	"billing_customers",
	{
		userId: text("user_id")
			.primaryKey()
			.references(() => users.id, { onDelete: "cascade" }),
		provider: text("provider", { enum: ["stripe"] }).notNull(),
		providerCustomerId: text("provider_customer_id").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("billing_customers_provider_customer_id_unique").on(table.provider, table.providerCustomerId),
		check("billing_customers_provider_valid", sql`${table.provider} = 'stripe'`),
	],
);

export const billingCheckoutAdmissions = sqliteTable(
	"billing_checkout_admissions",
	{
		userId: text("user_id")
			.primaryKey()
			.references(() => users.id, { onDelete: "cascade" }),
		idempotencyKey: text("idempotency_key").notNull(),
		interval: text("interval", { enum: ["month", "year"] }).notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
	},
	(table) => [
		check("billing_checkout_admissions_interval_valid", sql`${table.interval} IN ('month', 'year')`),
		check("billing_checkout_admissions_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
	],
);

export const billingSubscriptions = sqliteTable(
	"billing_subscriptions",
	{
		providerSubscriptionId: text("provider_subscription_id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		providerCustomerId: text("provider_customer_id").notNull(),
		priceId: text("price_id").notNull(),
		status: text("status", { enum: STRIPE_SUBSCRIPTION_STATUSES }).notNull(),
		providerEventCreatedAt: integer("provider_event_created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("billing_subscriptions_user_id_unique").on(table.userId),
		index("billing_subscriptions_customer_id_index").on(table.providerCustomerId),
		check(
			"billing_subscriptions_status_valid",
			sql`${table.status} IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')`,
		),
	],
);

export const stripeWebhookEvents = sqliteTable(
	"stripe_webhook_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		objectId: text("object_id").notNull(),
		eventCreatedAt: integer("event_created_at").notNull(),
		receivedAt: integer("received_at").notNull(),
		processedAt: integer("processed_at"),
	},
	(table) => [
		index("stripe_webhook_events_user_id_index").on(table.userId),
		index("stripe_webhook_events_processed_at_index").on(table.processedAt),
	],
);

export const serviceAlerts = sqliteTable(
	"service_alerts",
	{
		key: text("key").primaryKey(),
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		lastEmittedAt: integer("last_emitted_at").notNull(),
	},
	(table) => [index("service_alerts_user_id_index").on(table.userId)],
);
