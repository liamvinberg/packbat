import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { verifyGitHubAccessToken } from "./auth/github.js";
import {
	type AccessPrincipal,
	createAccessToken,
	parseRefreshToken,
	timestamp,
	verifyAccessToken,
} from "./auth/tokens.js";
import { billingStatus, createCheckout, createPortal } from "./billing/hosted.js";
import { type BillingBindings, BillingError } from "./billing/model.js";
import { handleStripeWebhook } from "./billing/webhook.js";
import {
	credentialIsActive,
	findOrCreateAccount,
	issueCredential,
	revokeCredential,
	rotateCredential,
} from "./db/accounts.js";
import { CLOUD_QUOTA_BYTES } from "./db/schema.js";
import { logAccountOperationalEventOnce, type OperationalReason } from "./operations/log.js";
import {
	createDownload,
	createMachineRemote,
	deleteAccountData,
	finalizeUpload,
	reserveUpload,
	type StorageBindings,
	StorageError,
} from "./storage/broker.js";
import { INDEX_OBJECT_KEY, isLogicalObjectKey } from "./storage/object-key.js";

interface RateLimiter {
	limit(input: { key: string }): Promise<{ success: boolean }>;
}

type CloudBindings = Env &
	StorageBindings &
	BillingBindings & {
		ACCESS_TOKEN_SECRET: string;
		API_RATE_LIMITER: RateLimiter;
		AUTH_RATE_LIMITER: RateLimiter;
		BILLING_RATE_LIMITER: RateLimiter;
		DOWNLOAD_RATE_LIMITER: RateLimiter;
		WEBHOOK_RATE_LIMITER: RateLimiter;
	};

interface CloudVariables {
	principal: AccessPrincipal;
}

type CloudHono = { Bindings: CloudBindings; Variables: CloudVariables };

const exchangeSchema = z.strictObject({ githubAccessToken: z.string().min(1) });
const refreshSchema = z.strictObject({ refreshToken: z.string().min(1) });
const machineSchema = z.strictObject({});
const machineRemoteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{24}$/u);
const logicalObjectKeySchema = z.string().refine(isLogicalObjectKey);
const reservationSchema = z
	.strictObject({
		checksumSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
		expectedBytes: z.number().int().positive().safe().max(CLOUD_QUOTA_BYTES),
		expectedArchiveCount: z.number().int().nonnegative().safe().optional(),
		expectedIndexEtag: z
			.string()
			.regex(/^[A-Za-z0-9-]{1,128}$/u)
			.nullable()
			.optional(),
		idempotencyKey: z.string().min(1).max(128),
		logicalObjectKey: logicalObjectKeySchema,
		machineRemoteId: machineRemoteIdSchema,
		sweepId: z.string().min(1).max(128),
	})
	.superRefine((value, context) => {
		if (value.logicalObjectKey === INDEX_OBJECT_KEY && value.expectedIndexEtag === undefined) {
			context.addIssue({ code: "custom", message: "expectedIndexEtag is required for the index" });
		}
		if (value.logicalObjectKey !== INDEX_OBJECT_KEY && value.expectedIndexEtag !== undefined) {
			context.addIssue({ code: "custom", message: "expectedIndexEtag is only valid for the index" });
		}
		if (value.logicalObjectKey === INDEX_OBJECT_KEY && value.expectedArchiveCount === undefined) {
			context.addIssue({ code: "custom", message: "expectedArchiveCount is required for the index" });
		}
		if (value.logicalObjectKey !== INDEX_OBJECT_KEY && value.expectedArchiveCount !== undefined) {
			context.addIssue({ code: "custom", message: "expectedArchiveCount is only valid for the index" });
		}
	});
const downloadSchema = z.strictObject({
	logicalObjectKey: logicalObjectKeySchema,
	machineRemoteId: machineRemoteIdSchema,
});
const reservationIdSchema = z.uuid();
const checkoutSchema = z.strictObject({
	idempotencyKey: z.string().min(1).max(128),
	interval: z.enum(["month", "year"]),
});

class ApiError extends Error {
	constructor(
		readonly status: 400 | 401 | 429,
		readonly code: string,
	) {
		super(code);
	}
}

async function enforceRateLimit(
	binding: D1Database,
	limiter: RateLimiter,
	key: string,
	accountId: string,
	reason: Extract<OperationalReason, "api_requests" | "billing_requests" | "download_requests">,
	now: number,
): Promise<void> {
	if (!(await limiter.limit({ key })).success) {
		await logAccountOperationalEventOnce(binding, { accountId, event: "rate_limited", now, reason });
		throw new ApiError(429, "rate_limited");
	}
}

async function enforcePublicAuthRateLimit(
	limiter: RateLimiter,
	request: Request,
	routeClass: "exchange" | "refresh",
): Promise<void> {
	const connectingIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
	if (!(await limiter.limit({ key: `${routeClass}:${connectingIp}` })).success) {
		throw new ApiError(429, "rate_limited");
	}
}

function now(): number {
	return Math.floor(Date.now() / 1_000);
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ApiError(400, "invalid_json");
	}
	const result = schema.safeParse(body);
	if (!result.success) {
		throw new ApiError(400, "invalid_request");
	}
	return result.data;
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
	return match?.[1] ?? null;
}

function authMiddleware(): MiddlewareHandler<CloudHono> {
	return async (context, next) => {
		const token = bearerToken(context.req.raw);
		const principal = token === null ? null : await createPrincipal(token, context.env);
		if (principal === null) {
			return context.json({ error: "invalid_access_token" }, 401);
		}
		await enforceRateLimit(
			context.env.DB,
			context.env.API_RATE_LIMITER,
			principal.userId,
			principal.userId,
			"api_requests",
			now(),
		);
		context.set("principal", principal);
		await next();
	};
}

async function createPrincipal(token: string, env: CloudBindings): Promise<AccessPrincipal | null> {
	const principal = await verifyAccessToken(token, env.ACCESS_TOKEN_SECRET);
	if (principal === null || !(await credentialIsActive(env.DB, principal, now()))) {
		return null;
	}
	return principal;
}

async function tokenResponse(
	credential: Awaited<ReturnType<typeof issueCredential>>,
	accessTokenSecret: string,
	extra?: { githubLogin: string },
) {
	const accessToken = await createAccessToken(
		{ credentialId: credential.refreshToken.credentialId, userId: credential.account.id },
		accessTokenSecret,
		now(),
	);
	return {
		accessToken: accessToken.value,
		accessTokenExpiresAt: timestamp(accessToken.expiresAt),
		account: {
			graceEndsAt: credential.account.graceEndsAt === null ? null : timestamp(credential.account.graceEndsAt),
			id: credential.account.id,
			quotaBytes: credential.account.quotaBytes,
			reservedBytes: credential.account.reservedBytes,
			subscriptionState: credential.account.subscriptionState,
			usedBytes: credential.account.usedBytes,
			...extra,
		},
		refreshToken: credential.refreshToken.value,
		refreshTokenExpiresAt: timestamp(credential.expiresAt),
		tokenType: "Bearer" as const,
	};
}

export function createApp() {
	const app = new Hono<CloudHono>();

	app.use("/v1/*", async (context, next) => {
		context.header("Cache-Control", "no-store");
		await next();
	});

	app.get("/healthz", (context) => context.json({ ok: true }));

	app.post("/v1/auth/github/exchange", async (context) => {
		await enforcePublicAuthRateLimit(context.env.AUTH_RATE_LIMITER, context.req.raw, "exchange");
		const { githubAccessToken } = await readJson(context.req.raw, exchangeSchema);
		const identity = await verifyGitHubAccessToken(githubAccessToken);
		if (identity === null) {
			throw new ApiError(401, "invalid_github_token");
		}
		const currentTime = now();
		const account = await findOrCreateAccount(context.env.DB, identity.subjectId, currentTime);
		const credential = await issueCredential(context.env.DB, account, currentTime);
		return context.json(
			await tokenResponse(credential, context.env.ACCESS_TOKEN_SECRET, { githubLogin: identity.login }),
		);
	});

	app.post("/v1/auth/refresh", async (context) => {
		await enforcePublicAuthRateLimit(context.env.AUTH_RATE_LIMITER, context.req.raw, "refresh");
		const { refreshToken: value } = await readJson(context.req.raw, refreshSchema);
		const refreshToken = await parseRefreshToken(value);
		if (refreshToken === null) {
			throw new ApiError(401, "invalid_refresh_token");
		}
		const credential = await rotateCredential(context.env.DB, refreshToken, now());
		if (credential === null) {
			throw new ApiError(401, "invalid_refresh_token");
		}
		return context.json(await tokenResponse(credential, context.env.ACCESS_TOKEN_SECRET));
	});

	app.post("/v1/billing/webhook", async (context) => {
		if (!(await context.env.WEBHOOK_RATE_LIMITER.limit({ key: "stripe" })).success) {
			return context.json({ error: "rate_limited" }, 429);
		}
		await handleStripeWebhook(
			context.env,
			await context.req.text(),
			context.req.header("Stripe-Signature") ?? null,
			now(),
		);
		return context.json({ received: true });
	});

	app.get("/v1/billing/status", authMiddleware(), async (context) => {
		return context.json(await billingStatus(context.env, context.get("principal").userId, now()));
	});

	app.post("/v1/billing/checkout", authMiddleware(), async (context) => {
		const principal = context.get("principal");
		await enforceRateLimit(
			context.env.DB,
			context.env.BILLING_RATE_LIMITER,
			principal.userId,
			principal.userId,
			"billing_requests",
			now(),
		);
		const input = await readJson(context.req.raw, checkoutSchema);
		return context.json(
			await createCheckout(context.env, principal.userId, input.interval, input.idempotencyKey, now()),
			201,
		);
	});

	app.post("/v1/billing/portal", authMiddleware(), async (context) => {
		const principal = context.get("principal");
		await enforceRateLimit(
			context.env.DB,
			context.env.BILLING_RATE_LIMITER,
			principal.userId,
			principal.userId,
			"billing_requests",
			now(),
		);
		return context.json(await createPortal(context.env, principal.userId));
	});

	app.delete("/v1/auth/credential", authMiddleware(), async (context) => {
		await revokeCredential(context.env.DB, context.get("principal"), now());
		return context.body(null, 204);
	});

	app.post("/v1/machines", authMiddleware(), async (context) => {
		await readJson(context.req.raw, machineSchema);
		const id = await createMachineRemote(context.env.DB, context.get("principal").userId, now());
		return context.json({ id }, 201);
	});

	app.post("/v1/uploads/reservations", authMiddleware(), async (context) => {
		const input = await readJson(context.req.raw, reservationSchema);
		const { expectedArchiveCount, expectedIndexEtag, ...requiredInput } = input;
		const result = await reserveUpload(
			context.env,
			context.get("principal").userId,
			{
				...requiredInput,
				...(expectedArchiveCount === undefined ? {} : { expectedArchiveCount }),
				...(expectedIndexEtag === undefined ? {} : { expectedIndexEtag }),
			},
			now(),
		);
		const body =
			result.state === "pending"
				? {
						reservationId: result.reservationId,
						state: result.state,
						upload: { ...result.upload, expiresAt: timestamp(result.upload.expiresAt) },
					}
				: result;
		return context.json(body, result.created ? 201 : 200);
	});

	app.post("/v1/uploads/:reservationId/finalize", authMiddleware(), async (context) => {
		const parsed = reservationIdSchema.safeParse(context.req.param("reservationId"));
		if (!parsed.success) {
			throw new ApiError(400, "invalid_request");
		}
		const result = await finalizeUpload(context.env, context.get("principal").userId, parsed.data, now());
		return context.json(result);
	});

	app.post("/v1/downloads", authMiddleware(), async (context) => {
		const principal = context.get("principal");
		await enforceRateLimit(
			context.env.DB,
			context.env.DOWNLOAD_RATE_LIMITER,
			principal.userId,
			principal.userId,
			"download_requests",
			now(),
		);
		const input = await readJson(context.req.raw, downloadSchema);
		const download = await createDownload(
			context.env,
			principal.userId,
			input.machineRemoteId,
			input.logicalObjectKey,
			now(),
		);
		return context.json({ ...download, expiresAt: timestamp(download.expiresAt) });
	});

	app.delete("/v1/account", authMiddleware(), async (context) => {
		const result = await deleteAccountData(context.env, context.get("principal").userId, now());
		return result.complete
			? context.body(null, 204)
			: context.json({ retryAt: timestamp(result.retryAt), state: "deletion_pending" }, 202);
	});

	app.notFound((context) => context.json({ error: "not_found" }, 404));
	app.onError((error, context) => {
		if (error instanceof ApiError || error instanceof BillingError || error instanceof StorageError) {
			return context.json({ error: error.code }, error.status);
		}
		return context.json({ error: "internal_error" }, 500);
	});

	return app;
}
