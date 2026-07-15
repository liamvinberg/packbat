# Packbat Cloud account service

Cloudflare Worker account boundary for optional Packbat Cloud. It verifies a one-time GitHub token, stores only the
GitHub numeric subject, and returns Packbat access and rotating refresh credentials. Browser OAuth is not part of
this service.

## Local development

Create `apps/cloud/.dev.vars` with a random `ACCESS_TOKEN_SECRET` of at least 32 bytes, then run:

```sh
pnpm -C apps/cloud db:migrate:local
pnpm -C apps/cloud dev
```

`wrangler.jsonc` deliberately contains a zero D1 ID for local work. The R2 broker ticket provisions the remote D1,
private R2 bucket, and deployed Worker before replacing that placeholder.

## API

- `POST /v1/auth/github/exchange` verifies a GitHub access token through `/user` and issues Packbat credentials.
- `POST /v1/auth/refresh` rotates a refresh token. Each refresh token works once.
- `DELETE /v1/auth/credential` revokes the authenticated CLI credential.
- `DELETE /v1/account` deletes the account and all current D1 control-plane state.
