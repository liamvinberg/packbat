CREATE TABLE `billing_customers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_customers_provider_valid" CHECK("billing_customers"."provider" = 'stripe')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_provider_customer_id_unique` ON `billing_customers` (`provider`,`provider_customer_id`);--> statement-breakpoint
CREATE TABLE `cli_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`refresh_token_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cli_credentials_expiry_after_creation" CHECK("cli_credentials"."expires_at" > "cli_credentials"."created_at"),
	CONSTRAINT "cli_credentials_revoked_after_creation" CHECK("cli_credentials"."revoked_at" IS NULL OR "cli_credentials"."revoked_at" >= "cli_credentials"."created_at")
);
--> statement-breakpoint
CREATE INDEX `cli_credentials_user_id_index` ON `cli_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `machine_remotes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`current_index_etag` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `machine_remotes_user_id_index` ON `machine_remotes` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_remotes_user_id_id_unique` ON `machine_remotes` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `object_ledger` (
	`user_id` text NOT NULL,
	`machine_remote_id` text NOT NULL,
	`logical_object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`etag` text NOT NULL,
	`last_completed_at` integer NOT NULL,
	PRIMARY KEY(`machine_remote_id`, `logical_object_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`machine_remote_id`) REFERENCES `machine_remotes`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "object_ledger_bytes_nonnegative" CHECK("object_ledger"."bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `object_ledger_user_id_index` ON `object_ledger` (`user_id`);--> statement-breakpoint
CREATE TABLE `upload_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_remote_id` text NOT NULL,
	`logical_object_key` text NOT NULL,
	`expected_bytes` integer NOT NULL,
	`checksum` text NOT NULL,
	`replaced_bytes` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`machine_remote_id`) REFERENCES `machine_remotes`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "upload_reservations_expected_bytes_nonnegative" CHECK("upload_reservations"."expected_bytes" >= 0),
	CONSTRAINT "upload_reservations_replaced_bytes_nonnegative" CHECK("upload_reservations"."replaced_bytes" >= 0),
	CONSTRAINT "upload_reservations_expiry_after_creation" CHECK("upload_reservations"."expires_at" > "upload_reservations"."created_at"),
	CONSTRAINT "upload_reservations_state_valid" CHECK("upload_reservations"."state" IN ('pending', 'completed', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_reservations_user_id_idempotency_key_unique` ON `upload_reservations` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `upload_reservations_expiry_index` ON `upload_reservations` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_subject_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`plan` text NOT NULL,
	`quota_bytes` integer NOT NULL,
	`used_bytes` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`storage_prefix` text NOT NULL,
	CONSTRAINT "users_github_subject_id_numeric" CHECK("users"."github_subject_id" <> '' AND "users"."github_subject_id" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "users_plan_valid" CHECK("users"."plan" IN ('free', 'paid')),
	CONSTRAINT "users_quota_bytes_nonnegative" CHECK("users"."quota_bytes" >= 0),
	CONSTRAINT "users_used_bytes_nonnegative" CHECK("users"."used_bytes" >= 0),
	CONSTRAINT "users_reserved_bytes_nonnegative" CHECK("users"."reserved_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_subject_id_unique` ON `users` (`github_subject_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_storage_prefix_unique` ON `users` (`storage_prefix`);