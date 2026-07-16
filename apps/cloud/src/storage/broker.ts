import { base64Url } from "../base64-url.js";
import { logAccountOperationalEventOnce, logOperationalEvent } from "../operations/log.js";
import { INDEX_OBJECT_KEY, objectKey, userObjectPrefix } from "./object-key.js";
import { OBJECT_CONTENT_TYPE, signDownload, signUpload } from "./r2-signing.js";

type StorageErrorStatus = 402 | 404 | 409 | 413;

export class StorageError extends Error {
	constructor(
		readonly status: StorageErrorStatus,
		readonly code: string,
	) {
		super(code);
	}
}

export interface StorageBindings {
	ARCHIVE_BUCKET: R2Bucket;
	DB: D1Database;
	R2_ACCESS_KEY_ID: string;
	R2_ACCOUNT_ID: string;
	R2_BUCKET_NAME: string;
	R2_SECRET_ACCESS_KEY: string;
}

export interface ReserveUploadInput {
	checksumSha256: string;
	expectedBytes: number;
	expectedArchiveCount?: number;
	expectedIndexEtag?: string | null;
	idempotencyKey: string;
	logicalObjectKey: string;
	machineRemoteId: string;
	sweepId: string;
}

interface ReservationContext {
	checksumSha256: string;
	deletionRequestedAt: number | null;
	expectedArchiveCount: number | null;
	expectedBytes: number;
	expectedIndexEtag: string | null;
	expiresAt: number;
	id: string;
	idempotencyKey: string;
	logicalObjectKey: string;
	machineRemoteId: string;
	replacedBytes: number;
	replacedEtag: string | null;
	state: "completed" | "expired" | "pending";
	storagePrefix: string;
	subscriptionState: "active" | "grace" | "inactive";
	sweepId: string;
	userId: string;
}

export type UploadReservationResult =
	| {
			created: boolean;
			reservationId: string;
			state: "pending";
			upload: Awaited<ReturnType<typeof signUpload>>;
	  }
	| { created: false; etag: string; reservationId: string; state: "completed" }
	| { created: false; reservationId: string; state: "expired" };

interface ReservationDiagnosis {
	archivesInSweep: number;
	completedArchivesInSweep: number;
	currentIndexEtag: string | null;
	deletionRequestedAt: number | null;
	pendingArchives: number;
	pendingIndex: number;
	pendingObject: number;
	quotaBytes: number;
	replacedBytes: number;
	reservedBytes: number;
	subscriptionState: "active" | "grace" | "inactive";
	sweepClosed: number;
	usedBytes: number;
}

const RESERVATION_LIFETIME_SECONDS = 5 * 60;
const RECONCILIATION_BATCH_SIZE = 100;
const DELETION_FENCE_BATCH_SIZE = 100;

function randomOpaqueId(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function signingConfig(env: StorageBindings) {
	return {
		accessKeyId: env.R2_ACCESS_KEY_ID,
		accountId: env.R2_ACCOUNT_ID,
		bucketName: env.R2_BUCKET_NAME,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
	};
}

function bytesToBase64(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function matchesReservation(object: R2Object, reservation: ReservationContext): boolean {
	return (
		object.size === reservation.expectedBytes &&
		object.checksums.sha256 !== undefined &&
		bytesToBase64(object.checksums.sha256) === reservation.checksumSha256 &&
		object.httpMetadata?.contentType === OBJECT_CONTENT_TYPE &&
		object.httpMetadata.contentLanguage === undefined &&
		object.httpMetadata.contentDisposition === undefined &&
		object.httpMetadata.contentEncoding === undefined &&
		object.httpMetadata.cacheControl === undefined &&
		object.httpMetadata.cacheExpiry === undefined &&
		Object.keys(object.customMetadata ?? {}).length === 0
	);
}

function isConstraintError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("SQLITE_CONSTRAINT");
}

async function getReservation(
	binding: D1Database,
	userId: string,
	where: "id" | "idempotency_key",
	value: string,
): Promise<ReservationContext | null> {
	return await binding
		.prepare(
			`SELECT
				r.checksum_sha256 AS checksumSha256,
				u.deletion_requested_at AS deletionRequestedAt,
				r.expected_archive_count AS expectedArchiveCount,
				r.expected_bytes AS expectedBytes,
				r.expected_index_etag AS expectedIndexEtag,
				r.expires_at AS expiresAt,
				r.id,
				r.idempotency_key AS idempotencyKey,
				r.logical_object_key AS logicalObjectKey,
				r.machine_remote_id AS machineRemoteId,
				r.replaced_bytes AS replacedBytes,
				r.replaced_etag AS replacedEtag,
				r.state,
				u.storage_prefix AS storagePrefix,
				u.subscription_state AS subscriptionState,
				r.sweep_id AS sweepId,
				r.user_id AS userId
			FROM upload_reservations r
			JOIN users u ON u.id = r.user_id
			WHERE r.user_id = ? AND r.${where} = ?`,
		)
		.bind(userId, value)
		.first<ReservationContext>();
}

async function completedEtag(binding: D1Database, reservation: ReservationContext): Promise<string> {
	const row = await binding
		.prepare("SELECT etag FROM object_ledger WHERE user_id = ? AND machine_remote_id = ? AND logical_object_key = ?")
		.bind(reservation.userId, reservation.machineRemoteId, reservation.logicalObjectKey)
		.first<{ etag: string }>();
	if (row === null) {
		throw new Error("completed reservation has no object ledger entry");
	}
	return row.etag;
}

async function pendingResult(
	env: StorageBindings,
	reservation: ReservationContext,
	now: number,
	created: boolean,
): Promise<UploadReservationResult> {
	const conditions = {
		checksumSha256: reservation.checksumSha256,
		contentLength: reservation.expectedBytes,
		expectedEtag:
			reservation.logicalObjectKey === INDEX_OBJECT_KEY ? reservation.expectedIndexEtag : reservation.replacedEtag,
	};
	return {
		created,
		reservationId: reservation.id,
		state: "pending",
		upload: await signUpload(
			signingConfig(env),
			objectKey(reservation.storagePrefix, reservation.machineRemoteId, reservation.logicalObjectKey),
			conditions,
			now,
			reservation.expiresAt,
		),
	};
}

async function reservationResult(
	env: StorageBindings,
	reservation: ReservationContext,
	now: number,
	created: boolean,
): Promise<UploadReservationResult> {
	if (reservation.state === "pending") {
		return await pendingResult(env, reservation, now, created);
	}
	if (reservation.state === "completed") {
		return {
			created: false,
			etag: await completedEtag(env.DB, reservation),
			reservationId: reservation.id,
			state: "completed",
		};
	}
	return { created: false, reservationId: reservation.id, state: "expired" };
}

function sameRequest(reservation: ReservationContext, input: ReserveUploadInput): boolean {
	return (
		reservation.checksumSha256 === input.checksumSha256 &&
		reservation.expectedArchiveCount === (input.expectedArchiveCount ?? null) &&
		reservation.expectedBytes === input.expectedBytes &&
		reservation.expectedIndexEtag === (input.expectedIndexEtag ?? null) &&
		reservation.logicalObjectKey === input.logicalObjectKey &&
		reservation.machineRemoteId === input.machineRemoteId &&
		reservation.sweepId === input.sweepId
	);
}

async function expireReservation(binding: D1Database, reservationId: string, now: number): Promise<void> {
	await binding.batch([
		binding
			.prepare(
				`UPDATE users
				SET
					used_bytes = used_bytes + (
						SELECT replaced_bytes FROM upload_reservations
						WHERE id = ? AND state = 'pending' AND expires_at <= ?
					),
					reserved_bytes = reserved_bytes - (
						SELECT expected_bytes FROM upload_reservations
						WHERE id = ? AND state = 'pending' AND expires_at <= ?
					)
				WHERE EXISTS (
					SELECT 1 FROM upload_reservations
					WHERE id = ? AND user_id = users.id AND state = 'pending' AND expires_at <= ?
				)`,
			)
			.bind(reservationId, now, reservationId, now, reservationId, now),
		binding
			.prepare(
				"UPDATE upload_reservations SET state = 'expired' WHERE id = ? AND state = 'pending' AND expires_at <= ?",
			)
			.bind(reservationId, now),
	]);
}

async function completeReservation(
	binding: D1Database,
	reservation: ReservationContext,
	object: R2Object,
	now: number,
): Promise<boolean> {
	const results = await binding.batch([
		binding
			.prepare(
				`INSERT INTO object_ledger (
					user_id, machine_remote_id, logical_object_key, bytes, etag, last_completed_at
				)
				SELECT r.user_id, r.machine_remote_id, r.logical_object_key, r.expected_bytes, ?, ?
				FROM upload_reservations r
				JOIN machine_remotes m ON m.id = r.machine_remote_id AND m.user_id = r.user_id
				WHERE r.id = ? AND r.state = 'pending'
					AND (r.logical_object_key <> ? OR m.current_index_etag IS r.expected_index_etag)
				ON CONFLICT (machine_remote_id, logical_object_key) DO UPDATE SET
					user_id = excluded.user_id,
					bytes = excluded.bytes,
					etag = excluded.etag,
					last_completed_at = excluded.last_completed_at`,
			)
			.bind(object.etag, now, reservation.id, INDEX_OBJECT_KEY),
		binding
			.prepare(
				`UPDATE users
				SET
					used_bytes = used_bytes + (
						SELECT expected_bytes FROM upload_reservations WHERE id = ?
					),
					reserved_bytes = reserved_bytes - (
						SELECT expected_bytes FROM upload_reservations WHERE id = ?
					)
				WHERE EXISTS (
					SELECT 1
					FROM upload_reservations r
					JOIN machine_remotes m ON m.id = r.machine_remote_id AND m.user_id = r.user_id
					WHERE r.id = ? AND r.user_id = users.id AND r.state = 'pending'
						AND (r.logical_object_key <> ? OR m.current_index_etag IS r.expected_index_etag)
				)`,
			)
			.bind(reservation.id, reservation.id, reservation.id, INDEX_OBJECT_KEY),
		binding
			.prepare(
				`UPDATE upload_reservations
				SET state = 'completed'
				WHERE id = ? AND state = 'pending' AND EXISTS (
					SELECT 1 FROM machine_remotes m
					WHERE m.id = upload_reservations.machine_remote_id
						AND m.user_id = upload_reservations.user_id
						AND (
							upload_reservations.logical_object_key <> ?
							OR m.current_index_etag IS upload_reservations.expected_index_etag
						)
				)`,
			)
			.bind(reservation.id, INDEX_OBJECT_KEY),
		binding
			.prepare(
				`UPDATE machine_remotes
				SET current_index_etag = ?
				WHERE id = ? AND user_id = ? AND EXISTS (
					SELECT 1 FROM upload_reservations r
					WHERE r.id = ? AND r.state = 'completed' AND r.logical_object_key = ?
						AND r.machine_remote_id = machine_remotes.id
						AND r.user_id = machine_remotes.user_id
						AND machine_remotes.current_index_etag IS r.expected_index_etag
				)`,
			)
			.bind(object.etag, reservation.machineRemoteId, reservation.userId, reservation.id, INDEX_OBJECT_KEY),
	]);
	return (results[2]?.meta.changes ?? 0) === 1;
}

async function removeUnexpectedObject(
	bucket: R2Bucket,
	key: string,
	object: R2Object,
	reservation: ReservationContext,
): Promise<void> {
	if (reservation.replacedEtag === null || object.etag !== reservation.replacedEtag) {
		await bucket.delete(key);
	}
}

async function reconcileReservation(env: StorageBindings, reservation: ReservationContext, now: number): Promise<void> {
	const key = objectKey(reservation.storagePrefix, reservation.machineRemoteId, reservation.logicalObjectKey);
	const object = await env.ARCHIVE_BUCKET.head(key);
	if (object !== null && matchesReservation(object, reservation)) {
		if (await completeReservation(env.DB, reservation, object, now)) {
			return;
		}
		const current = await getReservation(env.DB, reservation.userId, "id", reservation.id);
		if (current === null || current.state !== "pending") {
			return;
		}
	}
	if (object !== null) {
		await removeUnexpectedObject(env.ARCHIVE_BUCKET, key, object, reservation);
	}
	await expireReservation(env.DB, reservation.id, now);
}

async function reconcileExpiredReservations(env: StorageBindings, userId: string, now: number): Promise<void> {
	while (true) {
		const expired = await env.DB.prepare(
			`SELECT r.id FROM upload_reservations r
			JOIN users u ON u.id = r.user_id
			WHERE r.user_id = ? AND u.deletion_requested_at IS NULL
				AND r.state = 'pending' AND r.expires_at <= ? LIMIT ?`,
		)
			.bind(userId, now, RECONCILIATION_BATCH_SIZE)
			.all<{ id: string }>();
		if (expired.results.length === 0) {
			return;
		}
		for (const { id } of expired.results) {
			const reservation = await getReservation(env.DB, userId, "id", id);
			if (reservation !== null && reservation.state === "pending") {
				await reconcileReservation(env, reservation, now);
			}
		}
	}
}

export async function reconcileExpiredUploads(env: StorageBindings, now: number): Promise<void> {
	while (true) {
		const expired = await env.DB.prepare(
			`SELECT r.id, r.user_id AS userId
			FROM upload_reservations r
			JOIN users u ON u.id = r.user_id
			WHERE u.deletion_requested_at IS NULL AND r.state = 'pending' AND r.expires_at <= ?
			LIMIT ?`,
		)
			.bind(now, RECONCILIATION_BATCH_SIZE)
			.all<{ id: string; userId: string }>();
		if (expired.results.length === 0) {
			return;
		}
		for (const { id, userId } of expired.results) {
			const reservation = await getReservation(env.DB, userId, "id", id);
			if (reservation !== null && reservation.state === "pending" && reservation.deletionRequestedAt === null) {
				await reconcileReservation(env, reservation, now);
			}
		}
	}
}

export async function createMachineRemote(binding: D1Database, userId: string, now: number): Promise<string> {
	const id = randomOpaqueId();
	const result = await binding
		.prepare(
			`INSERT INTO machine_remotes (id, user_id, created_at)
			SELECT ?, id, ? FROM users
			WHERE id = ? AND deletion_requested_at IS NULL AND subscription_state = 'active'
			RETURNING id`,
		)
		.bind(id, now, userId)
		.first<{ id: string }>();
	if (result === null) {
		const deleting = await binding
			.prepare("SELECT deletion_requested_at FROM users WHERE id = ?")
			.bind(userId)
			.first<{ deletion_requested_at: number | null }>();
		if (deleting?.deletion_requested_at !== null && deleting?.deletion_requested_at !== undefined) {
			throw new StorageError(409, "account_deleting");
		}
		const subscription = await binding
			.prepare("SELECT subscription_state AS state FROM users WHERE id = ?")
			.bind(userId)
			.first<{ state: string }>();
		if (subscription !== null && subscription.state !== "active") {
			throw new StorageError(402, "subscription_required");
		}
		throw new StorageError(404, "account_not_found");
	}
	return result.id;
}

async function diagnoseReservation(
	binding: D1Database,
	userId: string,
	input: ReserveUploadInput,
	now: number,
): Promise<never> {
	const diagnosis = await binding
		.prepare(
			`SELECT
				(
					SELECT COUNT(*) FROM upload_reservations r
					WHERE r.user_id = u.id AND r.machine_remote_id = m.id AND r.sweep_id = ?
						AND r.logical_object_key <> ?
				) AS archivesInSweep,
				(
					SELECT COUNT(*) FROM upload_reservations r
					WHERE r.user_id = u.id AND r.machine_remote_id = m.id AND r.sweep_id = ?
						AND r.logical_object_key <> ? AND r.state = 'completed'
				) AS completedArchivesInSweep,
				m.current_index_etag AS currentIndexEtag,
				u.deletion_requested_at AS deletionRequestedAt,
				(
					SELECT COUNT(*) FROM upload_reservations r
					WHERE r.user_id = u.id AND r.machine_remote_id = m.id AND r.state = 'pending'
						AND r.expires_at > ? AND r.logical_object_key <> ?
				) AS pendingArchives,
				(
					SELECT COUNT(*) FROM upload_reservations r
					WHERE r.user_id = u.id AND r.machine_remote_id = m.id AND r.state = 'pending'
						AND r.expires_at > ? AND r.logical_object_key = ?
				) AS pendingIndex,
				(
					SELECT COUNT(*) FROM upload_reservations r
					WHERE r.user_id = u.id AND r.machine_remote_id = m.id AND r.state = 'pending'
						AND r.logical_object_key = ?
				) AS pendingObject,
				u.quota_bytes AS quotaBytes,
				COALESCE(o.bytes, 0) AS replacedBytes,
				u.reserved_bytes AS reservedBytes,
				u.subscription_state AS subscriptionState,
				(
					SELECT COUNT(*) FROM upload_reservations r
					WHERE r.user_id = u.id AND r.machine_remote_id = m.id AND r.sweep_id = ?
						AND r.logical_object_key = ?
				) AS sweepClosed,
				u.used_bytes AS usedBytes
			FROM users u
			JOIN machine_remotes m ON m.user_id = u.id AND m.id = ?
			LEFT JOIN object_ledger o ON o.user_id = u.id AND o.machine_remote_id = m.id
				AND o.logical_object_key = ?
			WHERE u.id = ?`,
		)
		.bind(
			input.sweepId,
			INDEX_OBJECT_KEY,
			input.sweepId,
			INDEX_OBJECT_KEY,
			now,
			INDEX_OBJECT_KEY,
			now,
			INDEX_OBJECT_KEY,
			input.logicalObjectKey,
			input.sweepId,
			INDEX_OBJECT_KEY,
			input.machineRemoteId,
			input.logicalObjectKey,
			userId,
		)
		.first<ReservationDiagnosis>();
	if (diagnosis === null) {
		throw new StorageError(404, "machine_not_found");
	}
	if (diagnosis.deletionRequestedAt !== null) {
		throw new StorageError(409, "account_deleting");
	}
	if (diagnosis.subscriptionState !== "active") {
		throw new StorageError(402, "subscription_required");
	}
	if (diagnosis.pendingObject > 0) {
		throw new StorageError(409, "upload_in_progress");
	}
	if (input.logicalObjectKey !== INDEX_OBJECT_KEY && diagnosis.pendingIndex > 0) {
		throw new StorageError(409, "index_pending");
	}
	if (input.logicalObjectKey !== INDEX_OBJECT_KEY && diagnosis.sweepClosed > 0) {
		throw new StorageError(409, "sweep_closed");
	}
	if (input.logicalObjectKey === INDEX_OBJECT_KEY) {
		if (diagnosis.currentIndexEtag !== (input.expectedIndexEtag ?? null)) {
			throw new StorageError(409, "index_conflict");
		}
		if (diagnosis.pendingArchives > 0) {
			throw new StorageError(409, "archives_pending");
		}
		if (
			diagnosis.archivesInSweep !== input.expectedArchiveCount ||
			diagnosis.completedArchivesInSweep !== input.expectedArchiveCount
		) {
			throw new StorageError(409, "sweep_incomplete");
		}
	}
	if (
		diagnosis.usedBytes + diagnosis.reservedBytes - diagnosis.replacedBytes + input.expectedBytes >
		diagnosis.quotaBytes
	) {
		await logAccountOperationalEventOnce(binding, {
			accountId: userId,
			event: "quota_exceeded",
			now,
			reason: "storage_bytes",
		});
		throw new StorageError(413, "quota_exceeded");
	}
	throw new StorageError(409, "reservation_conflict");
}

export async function reserveUpload(
	env: StorageBindings,
	userId: string,
	input: ReserveUploadInput,
	now: number,
): Promise<UploadReservationResult> {
	await reconcileExpiredReservations(env, userId, now);

	const existing = await getReservation(env.DB, userId, "idempotency_key", input.idempotencyKey);
	if (existing !== null) {
		if (existing.deletionRequestedAt !== null) {
			throw new StorageError(409, "account_deleting");
		}
		if (existing.subscriptionState !== "active") {
			throw new StorageError(402, "subscription_required");
		}
		if (!sameRequest(existing, input)) {
			throw new StorageError(409, "idempotency_conflict");
		}
		return await reservationResult(env, existing, now, false);
	}

	const id = crypto.randomUUID();
	const expiresAt = now + RESERVATION_LIFETIME_SECONDS;
	const isIndex = input.logicalObjectKey === INDEX_OBJECT_KEY ? 1 : 0;
	try {
		const results = await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO upload_reservations (
					id, user_id, machine_remote_id, logical_object_key, sweep_id, expected_archive_count,
					expected_bytes, checksum_sha256,
					replaced_bytes, replaced_etag, expected_index_etag, idempotency_key, created_at, expires_at, state
				)
				SELECT ?, u.id, m.id, ?, ?, ?, ?, ?, COALESCE(o.bytes, 0), o.etag, ?, ?, ?, ?, 'pending'
				FROM users u
				JOIN machine_remotes m ON m.user_id = u.id AND m.id = ?
				LEFT JOIN object_ledger o ON o.user_id = u.id AND o.machine_remote_id = m.id
					AND o.logical_object_key = ?
				WHERE u.id = ? AND u.deletion_requested_at IS NULL AND u.subscription_state = 'active'
					AND u.used_bytes + u.reserved_bytes - COALESCE(o.bytes, 0) + ? <= u.quota_bytes
					AND (? = 1 OR NOT EXISTS (
						SELECT 1 FROM upload_reservations closed
						WHERE closed.user_id = u.id AND closed.machine_remote_id = m.id
							AND closed.sweep_id = ? AND closed.logical_object_key = ?
					))
					AND (? = 1 OR NOT EXISTS (
						SELECT 1 FROM upload_reservations publishing
						WHERE publishing.user_id = u.id AND publishing.machine_remote_id = m.id
							AND publishing.state = 'pending' AND publishing.expires_at > ?
							AND publishing.logical_object_key = ?
					))
					AND (? = 0 OR (
						m.current_index_etag IS ?
						AND NOT EXISTS (
							SELECT 1 FROM upload_reservations pending
							WHERE pending.user_id = u.id AND pending.machine_remote_id = m.id
								AND pending.state = 'pending' AND pending.expires_at > ?
								AND pending.logical_object_key <> ?
						)
						AND ? = (
							SELECT COUNT(*) FROM upload_reservations swept
							WHERE swept.user_id = u.id AND swept.machine_remote_id = m.id
								AND swept.sweep_id = ? AND swept.logical_object_key <> ?
								AND swept.state = 'completed'
						)
						AND ? = (
							SELECT COUNT(*) FROM upload_reservations swept
							WHERE swept.user_id = u.id AND swept.machine_remote_id = m.id
								AND swept.sweep_id = ? AND swept.logical_object_key <> ?
						)
					))`,
			).bind(
				id,
				input.logicalObjectKey,
				input.sweepId,
				input.expectedArchiveCount ?? null,
				input.expectedBytes,
				input.checksumSha256,
				input.expectedIndexEtag ?? null,
				input.idempotencyKey,
				now,
				expiresAt,
				input.machineRemoteId,
				input.logicalObjectKey,
				userId,
				input.expectedBytes,
				isIndex,
				input.sweepId,
				INDEX_OBJECT_KEY,
				isIndex,
				now,
				INDEX_OBJECT_KEY,
				isIndex,
				input.expectedIndexEtag ?? null,
				now,
				INDEX_OBJECT_KEY,
				input.expectedArchiveCount ?? -1,
				input.sweepId,
				INDEX_OBJECT_KEY,
				input.expectedArchiveCount ?? -1,
				input.sweepId,
				INDEX_OBJECT_KEY,
			),
			env.DB.prepare(
				`UPDATE users
				SET
					used_bytes = used_bytes - (
						SELECT replaced_bytes FROM upload_reservations WHERE id = ?
					),
					reserved_bytes = reserved_bytes + ?
				WHERE id = ? AND EXISTS (
					SELECT 1 FROM upload_reservations
					WHERE id = ? AND user_id = users.id AND state = 'pending'
				)`,
			).bind(id, input.expectedBytes, userId, id),
		]);
		if ((results[0]?.meta.changes ?? 0) !== 1) {
			return await diagnoseReservation(env.DB, userId, input, now);
		}
	} catch (error) {
		const raced = await getReservation(env.DB, userId, "idempotency_key", input.idempotencyKey);
		if (raced !== null) {
			if (raced.deletionRequestedAt !== null) {
				throw new StorageError(409, "account_deleting");
			}
			if (!sameRequest(raced, input)) {
				throw new StorageError(409, "idempotency_conflict");
			}
			return await reservationResult(env, raced, now, false);
		}
		if (!isConstraintError(error)) {
			throw error;
		}
		return await diagnoseReservation(env.DB, userId, input, now);
	}

	const reservation = await getReservation(env.DB, userId, "id", id);
	if (reservation === null) {
		throw new Error("reservation was not available after creation");
	}
	return await pendingResult(env, reservation, now, true);
}

export async function finalizeUpload(
	env: StorageBindings,
	userId: string,
	reservationId: string,
	now: number,
): Promise<{ etag: string }> {
	const reservation = await getReservation(env.DB, userId, "id", reservationId);
	if (reservation === null) {
		throw new StorageError(404, "reservation_not_found");
	}
	if (reservation.deletionRequestedAt !== null) {
		throw new StorageError(409, "account_deleting");
	}
	if (reservation.state === "completed") {
		return { etag: await completedEtag(env.DB, reservation) };
	}
	if (reservation.state === "expired") {
		throw new StorageError(409, "reservation_expired");
	}

	const key = objectKey(reservation.storagePrefix, reservation.machineRemoteId, reservation.logicalObjectKey);
	const object = await env.ARCHIVE_BUCKET.head(key);
	if (object === null) {
		if (reservation.expiresAt <= now) {
			await expireReservation(env.DB, reservation.id, now);
			throw new StorageError(409, "reservation_expired");
		}
		throw new StorageError(409, "upload_missing");
	}
	if (!matchesReservation(object, reservation)) {
		await removeUnexpectedObject(env.ARCHIVE_BUCKET, key, object, reservation);
		if (reservation.expiresAt <= now) {
			await expireReservation(env.DB, reservation.id, now);
			throw new StorageError(409, "reservation_expired");
		}
		throw new StorageError(409, "upload_mismatch");
	}
	if (!(await completeReservation(env.DB, reservation, object, now))) {
		const current = await getReservation(env.DB, userId, "id", reservation.id);
		if (current?.state === "completed") {
			return { etag: await completedEtag(env.DB, current) };
		}
		throw new StorageError(409, "index_conflict");
	}
	return { etag: object.etag };
}

export async function createDownload(
	env: StorageBindings,
	userId: string,
	machineRemoteId: string,
	logicalObjectKey: string,
	now: number,
): Promise<{ expiresAt: number; url: string }> {
	const object = await env.DB.prepare(
		`SELECT u.storage_prefix AS storagePrefix
		FROM object_ledger o
		JOIN users u ON u.id = o.user_id
		WHERE o.user_id = ? AND u.deletion_requested_at IS NULL
			AND (
				u.subscription_state = 'active'
				OR (u.subscription_state = 'grace' AND u.grace_ends_at > ?)
			)
			AND o.machine_remote_id = ? AND o.logical_object_key = ?`,
	)
		.bind(userId, now, machineRemoteId, logicalObjectKey)
		.first<{ storagePrefix: string }>();
	if (object === null) {
		throw new StorageError(404, "object_not_found");
	}
	return await signDownload(
		signingConfig(env),
		objectKey(object.storagePrefix, machineRemoteId, logicalObjectKey),
		now,
	);
}

export async function reconcileUsageAccounting(binding: D1Database, now: number): Promise<void> {
	const repaired = await binding
		.prepare(
			`UPDATE users SET
				used_bytes = COALESCE((
					SELECT SUM(o.bytes) FROM object_ledger o WHERE o.user_id = users.id
				), 0) - COALESCE((
					SELECT SUM(r.replaced_bytes) FROM upload_reservations r
					WHERE r.user_id = users.id AND r.state = 'pending'
				), 0),
				reserved_bytes = COALESCE((
					SELECT SUM(r.expected_bytes) FROM upload_reservations r
					WHERE r.user_id = users.id AND r.state = 'pending'
				), 0)
			WHERE used_bytes <> COALESCE((
					SELECT SUM(o.bytes) FROM object_ledger o WHERE o.user_id = users.id
				), 0) - COALESCE((
					SELECT SUM(r.replaced_bytes) FROM upload_reservations r
					WHERE r.user_id = users.id AND r.state = 'pending'
				), 0)
				OR reserved_bytes <> COALESCE((
					SELECT SUM(r.expected_bytes) FROM upload_reservations r
					WHERE r.user_id = users.id AND r.state = 'pending'
				), 0)
			RETURNING id`,
		)
		.all<{ id: string }>();
	for (const account of repaired.results) {
		logOperationalEvent({
			accountId: account.id,
			event: "accounting_reconciled",
			now,
			reason: "accounting_drift",
			severity: "error",
		});
	}
}

async function deleteAccountDataWithGuard(
	env: StorageBindings,
	userId: string,
	now: number,
	requireExpiredGrace: boolean,
): Promise<{ complete: true } | { complete: false; retryAt: number }> {
	const account = requireExpiredGrace
		? await env.DB.prepare(
				`UPDATE users SET
					deletion_requested_at = COALESCE(deletion_requested_at, ?),
					delete_after = COALESCE(
						delete_after,
						MAX(?, COALESCE((SELECT MAX(expires_at) + 1 FROM upload_reservations WHERE user_id = users.id), ?))
					)
				WHERE id = ? AND subscription_state = 'grace' AND grace_ends_at <= ?
					AND NOT EXISTS (
						SELECT 1 FROM billing_checkout_admissions a
						WHERE a.user_id = users.id AND a.expires_at > ?
					)
				RETURNING storage_prefix AS storagePrefix, delete_after AS deleteAfter`,
			)
				.bind(now, now, now, userId, now, now)
				.first<{ deleteAfter: number; storagePrefix: string }>()
		: await env.DB.prepare(
				`UPDATE users SET
			deletion_requested_at = COALESCE(deletion_requested_at, ?),
			delete_after = COALESCE(
				delete_after,
				MAX(?, COALESCE((SELECT MAX(expires_at) + 1 FROM upload_reservations WHERE user_id = users.id), ?))
			)
		WHERE id = ? RETURNING storage_prefix AS storagePrefix, delete_after AS deleteAfter`,
			)
				.bind(now, now, now, userId)
				.first<{ deleteAfter: number; storagePrefix: string }>();
	if (account === null) {
		return { complete: true };
	}

	const unfenced = await env.DB.prepare(
		`SELECT DISTINCT r.machine_remote_id AS machineRemoteId, r.logical_object_key AS logicalObjectKey
		FROM upload_reservations r
		JOIN users u ON u.id = r.user_id
		WHERE r.user_id = ? AND r.write_fenced_at IS NULL
			AND r.expires_at >= u.deletion_requested_at
		LIMIT ?`,
	)
		.bind(userId, DELETION_FENCE_BATCH_SIZE)
		.all<{ logicalObjectKey: string; machineRemoteId: string }>();
	if (unfenced.results.length > 0) {
		for (const target of unfenced.results) {
			await env.ARCHIVE_BUCKET.put(
				objectKey(account.storagePrefix, target.machineRemoteId, target.logicalObjectKey),
				new Uint8Array(0),
				{ httpMetadata: { contentType: OBJECT_CONTENT_TYPE } },
			);
		}
		await env.DB.batch(
			unfenced.results.map((target) =>
				env.DB.prepare(
					`UPDATE upload_reservations SET write_fenced_at = ?
					WHERE user_id = ? AND machine_remote_id = ? AND logical_object_key = ?
						AND write_fenced_at IS NULL
						AND expires_at >= (SELECT deletion_requested_at FROM users WHERE id = ?)`,
				).bind(now, userId, target.machineRemoteId, target.logicalObjectKey, userId),
			),
		);
		if (unfenced.results.length === DELETION_FENCE_BATCH_SIZE) {
			return { complete: false, retryAt: now };
		}
	}
	if (now < account.deleteAfter) {
		return { complete: false, retryAt: account.deleteAfter };
	}

	const prefix = userObjectPrefix(account.storagePrefix);
	const listed = await env.ARCHIVE_BUCKET.list({ limit: 1_000, prefix });
	if (listed.objects.length > 0) {
		await env.ARCHIVE_BUCKET.delete(listed.objects.map(({ key }) => key));
	}
	if (listed.truncated) {
		return { complete: false, retryAt: now };
	}
	await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
	return { complete: true };
}

export async function deleteAccountData(
	env: StorageBindings,
	userId: string,
	now: number,
): Promise<{ complete: true } | { complete: false; retryAt: number }> {
	return await deleteAccountDataWithGuard(env, userId, now, false);
}

export async function deleteExpiredGraceAccountData(
	env: StorageBindings,
	userId: string,
	now: number,
): Promise<{ complete: true } | { complete: false; retryAt: number }> {
	return await deleteAccountDataWithGuard(env, userId, now, true);
}
