import { sign, verify } from "hono/jwt";
import { z } from "zod";
import { base64Url } from "../base64-url.js";

const ACCESS_TOKEN_AUDIENCE = "packbat-cli";
const ACCESS_TOKEN_ISSUER = "https://api.packbat.dev";
const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
export const REFRESH_TOKEN_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

const accessClaimsSchema = z.object({
	aud: z.literal(ACCESS_TOKEN_AUDIENCE),
	cid: z.uuid(),
	exp: z.number().int(),
	iat: z.number().int(),
	iss: z.literal(ACCESS_TOKEN_ISSUER),
	sub: z.uuid(),
});

export interface AccessPrincipal {
	credentialId: string;
	userId: string;
}

export interface AccessToken {
	expiresAt: number;
	value: string;
}

export interface RefreshToken {
	credentialId: string;
	digest: string;
	value: string;
}

function assertSigningSecret(secret: string): void {
	if (new TextEncoder().encode(secret).byteLength < 32) {
		throw new Error("ACCESS_TOKEN_SECRET must contain at least 32 bytes");
	}
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return base64Url(new Uint8Array(digest));
}

export async function createAccessToken(principal: AccessPrincipal, secret: string, now: number): Promise<AccessToken> {
	assertSigningSecret(secret);
	const expiresAt = now + ACCESS_TOKEN_LIFETIME_SECONDS;
	const value = await sign(
		{
			aud: ACCESS_TOKEN_AUDIENCE,
			cid: principal.credentialId,
			exp: expiresAt,
			iat: now,
			iss: ACCESS_TOKEN_ISSUER,
			sub: principal.userId,
		},
		secret,
		"HS256",
	);
	return { expiresAt, value };
}

export async function verifyAccessToken(value: string, secret: string): Promise<AccessPrincipal | null> {
	assertSigningSecret(secret);
	try {
		const payload = await verify(value, secret, {
			alg: "HS256",
			aud: ACCESS_TOKEN_AUDIENCE,
			iss: ACCESS_TOKEN_ISSUER,
		});
		const result = accessClaimsSchema.safeParse(payload);
		return result.success ? { credentialId: result.data.cid, userId: result.data.sub } : null;
	} catch {
		return null;
	}
}

export async function createRefreshToken(credentialId: string): Promise<RefreshToken> {
	const secret = crypto.getRandomValues(new Uint8Array(32));
	const value = `pb_refresh_${credentialId}.${base64Url(secret)}`;
	return { credentialId, digest: await sha256(value), value };
}

export async function parseRefreshToken(value: string): Promise<RefreshToken | null> {
	const match =
		/^pb_refresh_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u.exec(value);
	const credentialId = match?.[1];
	if (credentialId === undefined) {
		return null;
	}
	return { credentialId, digest: await sha256(value), value };
}

export function timestamp(seconds: number): string {
	return new Date(seconds * 1_000).toISOString();
}
