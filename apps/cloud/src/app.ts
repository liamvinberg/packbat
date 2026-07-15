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
import {
	credentialIsActive,
	deleteAccount,
	findOrCreateAccount,
	issueCredential,
	revokeCredential,
	rotateCredential,
} from "./db/accounts.js";

interface CloudBindings extends Env {
	ACCESS_TOKEN_SECRET: string;
}

interface CloudVariables {
	principal: AccessPrincipal;
}

type CloudHono = { Bindings: CloudBindings; Variables: CloudVariables };

const exchangeSchema = z.strictObject({ githubAccessToken: z.string().min(1) });
const refreshSchema = z.strictObject({ refreshToken: z.string().min(1) });

class ApiError extends Error {
	constructor(
		readonly status: 400 | 401,
		readonly code: string,
	) {
		super(code);
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
			id: credential.account.id,
			plan: credential.account.plan,
			quotaBytes: credential.account.quotaBytes,
			reservedBytes: credential.account.reservedBytes,
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

	app.use("/v1/auth/*", async (context, next) => {
		await next();
		context.header("Cache-Control", "no-store");
	});

	app.get("/healthz", (context) => context.json({ ok: true }));

	app.post("/v1/auth/github/exchange", async (context) => {
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

	app.delete("/v1/auth/credential", authMiddleware(), async (context) => {
		await revokeCredential(context.env.DB, context.get("principal"), now());
		return context.body(null, 204);
	});

	app.delete("/v1/account", authMiddleware(), async (context) => {
		await deleteAccount(context.env.DB, context.get("principal").userId);
		return context.body(null, 204);
	});

	app.notFound((context) => context.json({ error: "not_found" }, 404));
	app.onError((error, context) => {
		if (error instanceof ApiError) {
			return context.json({ error: error.code }, error.status);
		}
		return context.json({ error: "internal_error" }, 500);
	});

	return app;
}
