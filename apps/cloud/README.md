# Packbat Cloud service

Cloudflare Worker for optional Packbat Cloud. It owns the minimized account boundary plus a private R2 ciphertext
broker. Archive bytes transfer directly through short-lived, exact-object presigned URLs; the Worker retains quota,
ordering, finalization, and deletion authority. Browser OAuth is not part of this service.

## Local development

Create `apps/cloud/.dev.vars` with the following values, then run:

```text
ACCESS_TOKEN_SECRET=<random value of at least 32 bytes>
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_ACCESS_KEY_ID=<bucket-scoped object read/write key>
R2_SECRET_ACCESS_KEY=<matching secret>
R2_BUCKET_NAME=packbat-cloud-archives
```

```sh
pnpm -C apps/cloud db:migrate:local
pnpm -C apps/cloud dev
```

`wrangler.jsonc` contains a zero D1 ID until the production database is provisioned. Production setup creates the
private `packbat-cloud-archives` R2 Standard bucket, replaces that ID, adds the real `R2_ACCOUNT_ID` as a Worker
variable, applies the D1 migrations, stores `ACCESS_TOKEN_SECRET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`
with `wrangler secret put`, and then deploys the Worker. The R2 API key must be scoped to object read/write access
on that bucket only; `R2_BUCKET_NAME` is the private bucket's configured name.

The live hard-quota proof passed against the production R2 S3 endpoint on 2026-07-16. The signed five-byte PUT never
stored more than five bytes when the client sent a different header, a longer body, or a shorter body. See
[`docs/research/r2-content-length-proof.md`](../../docs/research/r2-content-length-proof.md).

Re-run it with the bucket-scoped R2 credentials before changing the upload path:

```sh
pnpm -C apps/cloud proof:r2-length
```

It signs a five-byte PUT, tries changed, shorter, and longer bodies through a raw HTTP client, verifies R2 never
stores more than the signed length, and removes every synthetic proof object.

## API

- `POST /v1/auth/github/exchange` verifies a GitHub access token through `/user` and issues Packbat credentials.
- `POST /v1/auth/refresh` rotates a refresh token. Each refresh token works once.
- `DELETE /v1/auth/credential` revokes the authenticated CLI credential.
- `POST /v1/machines` registers an opaque remote machine namespace.
- `POST /v1/uploads/reservations` atomically reserves quota and returns exact-object upload authority. Every request
  carries a sweep ID; an index also declares the sweep's archive count and prior index ETag.
- `POST /v1/uploads/:reservationId/finalize` verifies R2 length and SHA-256 before publishing the ledger entry.
- `POST /v1/downloads` returns short-lived read authority for a committed ciphertext object.
- `DELETE /v1/account` fences every outstanding upload URL, then removes the complete R2 prefix before its D1 rows.
  It returns `202 deletion_pending` with `retryAt` while those fenced URLs finish expiring; retry until `204`.
