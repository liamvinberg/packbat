import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
	type AccessPrincipal,
	createRefreshToken,
	REFRESH_TOKEN_LIFETIME_SECONDS,
	type RefreshToken,
} from "../auth/tokens.js";
import { base64Url } from "../base64-url.js";
import { CLOUD_QUOTA_BYTES, cliCredentials, users } from "./schema.js";

export interface Account {
	graceEndsAt: number | null;
	id: string;
	quotaBytes: number;
	reservedBytes: number;
	subscriptionState: "active" | "grace" | "inactive";
	usedBytes: number;
}

export interface IssuedCredential {
	account: Account;
	expiresAt: number;
	refreshToken: RefreshToken;
}

function randomStoragePrefix(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function toAccount(user: typeof users.$inferSelect): Account {
	return {
		graceEndsAt: user.graceEndsAt,
		id: user.id,
		quotaBytes: user.quotaBytes,
		reservedBytes: user.reservedBytes,
		subscriptionState: user.subscriptionState,
		usedBytes: user.usedBytes,
	};
}

export async function findOrCreateAccount(binding: D1Database, githubSubjectId: string, now: number): Promise<Account> {
	const database = drizzle(binding);
	await database
		.insert(users)
		.values({
			id: crypto.randomUUID(),
			githubSubjectId,
			createdAt: now,
			quotaBytes: CLOUD_QUOTA_BYTES,
			usedBytes: 0,
			reservedBytes: 0,
			storagePrefix: randomStoragePrefix(),
		})
		.onConflictDoNothing({ target: users.githubSubjectId });
	const [user] = await database.select().from(users).where(eq(users.githubSubjectId, githubSubjectId)).limit(1);
	if (user === undefined) {
		throw new Error("account was not available after creation");
	}
	return toAccount(user);
}

export async function issueCredential(binding: D1Database, account: Account, now: number): Promise<IssuedCredential> {
	const database = drizzle(binding);
	const credentialId = crypto.randomUUID();
	const refreshToken = await createRefreshToken(credentialId);
	const expiresAt = now + REFRESH_TOKEN_LIFETIME_SECONDS;
	await database.insert(cliCredentials).values({
		id: credentialId,
		userId: account.id,
		refreshTokenDigest: refreshToken.digest,
		createdAt: now,
		expiresAt,
	});
	return { account, expiresAt, refreshToken };
}

export async function rotateCredential(
	binding: D1Database,
	refreshToken: RefreshToken,
	now: number,
): Promise<IssuedCredential | null> {
	const database = drizzle(binding);
	const replacement = await createRefreshToken(refreshToken.credentialId);
	const expiresAt = now + REFRESH_TOKEN_LIFETIME_SECONDS;
	const [credential] = await database
		.update(cliCredentials)
		.set({ expiresAt, refreshTokenDigest: replacement.digest })
		.where(
			and(
				eq(cliCredentials.id, refreshToken.credentialId),
				eq(cliCredentials.refreshTokenDigest, refreshToken.digest),
				gt(cliCredentials.expiresAt, now),
				isNull(cliCredentials.revokedAt),
			),
		)
		.returning({ userId: cliCredentials.userId });
	if (credential === undefined) {
		return null;
	}
	const [user] = await database.select().from(users).where(eq(users.id, credential.userId)).limit(1);
	if (user === undefined) {
		return null;
	}
	return { account: toAccount(user), expiresAt, refreshToken: replacement };
}

export async function credentialIsActive(
	binding: D1Database,
	principal: AccessPrincipal,
	now: number,
): Promise<boolean> {
	const database = drizzle(binding);
	const [credential] = await database
		.select({ id: cliCredentials.id })
		.from(cliCredentials)
		.where(
			and(
				eq(cliCredentials.id, principal.credentialId),
				eq(cliCredentials.userId, principal.userId),
				gt(cliCredentials.expiresAt, now),
				isNull(cliCredentials.revokedAt),
			),
		)
		.limit(1);
	return credential !== undefined;
}

export async function revokeCredential(binding: D1Database, principal: AccessPrincipal, now: number): Promise<void> {
	const database = drizzle(binding);
	await database
		.update(cliCredentials)
		.set({ revokedAt: now })
		.where(and(eq(cliCredentials.id, principal.credentialId), eq(cliCredentials.userId, principal.userId)));
}
