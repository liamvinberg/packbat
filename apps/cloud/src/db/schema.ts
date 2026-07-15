import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const FREE_QUOTA_BYTES = 10_000_000_000;

export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		githubSubjectId: text("github_subject_id").notNull(),
		createdAt: integer("created_at").notNull(),
		plan: text("plan", { enum: ["free", "paid"] }).notNull(),
		quotaBytes: integer("quota_bytes").notNull(),
		usedBytes: integer("used_bytes").notNull(),
		reservedBytes: integer("reserved_bytes").notNull(),
		storagePrefix: text("storage_prefix").notNull(),
	},
	(table) => [
		uniqueIndex("users_github_subject_id_unique").on(table.githubSubjectId),
		uniqueIndex("users_storage_prefix_unique").on(table.storagePrefix),
		check(
			"users_github_subject_id_numeric",
			sql`${table.githubSubjectId} <> '' AND ${table.githubSubjectId} NOT GLOB '*[^0-9]*'`,
		),
		check("users_plan_valid", sql`${table.plan} IN ('free', 'paid')`),
		check("users_quota_bytes_nonnegative", sql`${table.quotaBytes} >= 0`),
		check("users_used_bytes_nonnegative", sql`${table.usedBytes} >= 0`),
		check("users_reserved_bytes_nonnegative", sql`${table.reservedBytes} >= 0`),
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
		expectedBytes: integer("expected_bytes").notNull(),
		checksum: text("checksum").notNull(),
		replacedBytes: integer("replaced_bytes").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		state: text("state", { enum: ["pending", "completed", "expired"] }).notNull(),
	},
	(table) => [
		uniqueIndex("upload_reservations_user_id_idempotency_key_unique").on(table.userId, table.idempotencyKey),
		index("upload_reservations_expiry_index").on(table.state, table.expiresAt),
		foreignKey({
			columns: [table.userId, table.machineRemoteId],
			foreignColumns: [machineRemotes.userId, machineRemotes.id],
		}).onDelete("cascade"),
		check("upload_reservations_expected_bytes_nonnegative", sql`${table.expectedBytes} >= 0`),
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
