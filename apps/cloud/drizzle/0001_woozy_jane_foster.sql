CREATE TABLE `billing_checkout_admissions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`interval` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_checkout_admissions_interval_valid" CHECK("billing_checkout_admissions"."interval" IN ('month', 'year')),
	CONSTRAINT "billing_checkout_admissions_expiry_after_creation" CHECK("billing_checkout_admissions"."expires_at" > "billing_checkout_admissions"."created_at")
);
--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
	`provider_subscription_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_customer_id` text NOT NULL,
	`price_id` text NOT NULL,
	`status` text NOT NULL,
	`provider_event_created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_subscriptions_status_valid" CHECK("billing_subscriptions"."status" IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_subscriptions_user_id_unique` ON `billing_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `billing_subscriptions_customer_id_index` ON `billing_subscriptions` (`provider_customer_id`);--> statement-breakpoint
CREATE TABLE `service_alerts` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`last_emitted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `service_alerts_user_id_index` ON `service_alerts` (`user_id`);--> statement-breakpoint
CREATE TABLE `stripe_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`object_id` text NOT NULL,
	`event_created_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stripe_webhook_events_user_id_index` ON `stripe_webhook_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `stripe_webhook_events_processed_at_index` ON `stripe_webhook_events` (`processed_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_subject_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`quota_bytes` integer NOT NULL,
	`used_bytes` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`storage_prefix` text NOT NULL,
	`subscription_activated_at` integer,
	`subscription_state` text DEFAULT 'inactive' NOT NULL,
	`grace_started_at` integer,
	`grace_ends_at` integer,
	`deletion_requested_at` integer,
	`delete_after` integer,
	CONSTRAINT "users_github_subject_id_numeric" CHECK("github_subject_id" <> '' AND "github_subject_id" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "users_quota_bytes_nonnegative" CHECK("quota_bytes" >= 0),
	CONSTRAINT "users_used_bytes_nonnegative" CHECK("used_bytes" >= 0),
	CONSTRAINT "users_reserved_bytes_nonnegative" CHECK("reserved_bytes" >= 0),
	CONSTRAINT "users_subscription_state_valid" CHECK("subscription_state" IN ('inactive', 'active', 'grace')),
	CONSTRAINT "users_subscription_lifecycle_valid" CHECK((
				"subscription_state" = 'inactive'
				AND "subscription_activated_at" IS NULL
				AND "grace_started_at" IS NULL
				AND "grace_ends_at" IS NULL
			) OR (
				"subscription_state" = 'active'
				AND "subscription_activated_at" IS NOT NULL
				AND "grace_started_at" IS NULL
				AND "grace_ends_at" IS NULL
			) OR (
				"subscription_state" = 'grace'
				AND "subscription_activated_at" IS NOT NULL
				AND "grace_started_at" IS NOT NULL
				AND "grace_ends_at" > "grace_started_at"
			))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "github_subject_id", "created_at", "quota_bytes", "used_bytes", "reserved_bytes", "storage_prefix", "deletion_requested_at", "delete_after") SELECT "id", "github_subject_id", "created_at", "quota_bytes", "used_bytes", "reserved_bytes", "storage_prefix", "deletion_requested_at", "delete_after" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_subject_id_unique` ON `users` (`github_subject_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_storage_prefix_unique` ON `users` (`storage_prefix`);
