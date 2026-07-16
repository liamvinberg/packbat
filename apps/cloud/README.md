# Packbat Cloud service

Cloudflare Worker for optional Packbat Cloud. It owns the minimized account and paid-subscription boundary plus a
private R2 ciphertext broker. Archive bytes transfer directly through short-lived, exact-object presigned URLs; the
Worker retains subscription admission, quota, ordering, finalization, reconciliation, and deletion authority.
Browser OAuth is not part of this service.

## Local development

Create `apps/cloud/.dev.vars` with the following values, then run:

```text
ACCESS_TOKEN_SECRET=<random value of at least 32 bytes>
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_ACCESS_KEY_ID=<bucket-scoped object read/write key>
R2_SECRET_ACCESS_KEY=<matching secret>
R2_BUCKET_NAME=packbat
STORAGE_ALERT_BYTES=1000000000000
STRIPE_ANNUAL_PRICE_ID=<annual recurring Price ID>
STRIPE_CHECKOUT_CANCEL_URL=<public cancel page URL>
STRIPE_CHECKOUT_SUCCESS_URL=<public success page URL>
STRIPE_LIVEMODE=false
STRIPE_MONTHLY_PRICE_ID=<monthly recurring Price ID>
STRIPE_PORTAL_RETURN_URL=<public return URL>
STRIPE_SECRET_KEY=<sandbox secret key>
STRIPE_WEBHOOK_SECRET=<sandbox endpoint signing secret>
```

```sh
pnpm -C apps/cloud db:migrate:local
pnpm -C apps/cloud dev
```

`wrangler.jsonc` contains a zero D1 ID and placeholder Stripe Price IDs until production is provisioned. Production
setup uses the private `packbat` R2 Standard bucket, replaces the D1 ID and both Price IDs, sets the public Checkout
and Portal URLs, adds the real `R2_ACCOUNT_ID` as a Worker variable, applies the D1 migrations, and then deploys.
Store `ACCESS_TOKEN_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY`, and
`STRIPE_WEBHOOK_SECRET` with `wrangler secret put`. The R2 API key must be scoped to object read/write access on that
bucket only; `R2_BUCKET_NAME` is the private bucket's configured name.

## Stripe production setup

1. Create one Packbat Cloud product with recurring Prices of USD $5 monthly and USD $50 annually. Put those Price
   IDs in `STRIPE_MONTHLY_PRICE_ID` and `STRIPE_ANNUAL_PRICE_ID`; do not configure a trial.
2. Enable Stripe Tax and the registrations required for the business. Checkout requests automatic tax, saves the
   collected name/address to the Stripe Customer, and allows tax-ID collection. Packbat never receives or stores the
   billing identity or email.
3. Configure the hosted Customer Portal for payment-method changes, invoices, and cancellation at period end. Do
   not expose plan quantities, teams, trial, or a second product tier.
4. Create an HTTPS webhook endpoint at `/v1/billing/webhook`, pinned to Stripe API `2026-02-25.clover`, with only
   `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Store its
   distinct signing secret as `STRIPE_WEBHOOK_SECRET` and set `STRIPE_LIVEMODE=true` for production.
5. Make both Checkout return pages real before launch. The success page tells the user to return to the terminal;
   the CLI continues only after `GET /v1/billing/status` reports `active`.
6. Enable Stripe's failed-payment and cancellation emails. Stripe remains the only system holding the customer's
   email and therefore owns lapse notices.

Stripe webhook signatures are checked over the untouched request body with Web Crypto and a five-minute timestamp
tolerance. Event IDs are deduplicated, older subscription snapshots cannot overwrite newer state, and same-second
conflicts fail closed rather than restoring upload access. See [Stripe's webhook contract](https://docs.stripe.com/webhooks)
and [subscription lifecycle](https://docs.stripe.com/billing/subscriptions/webhooks).

Checkout admission is durable before the first Stripe request. One account can hold one 31-minute Checkout admission
and one current provider subscription. A caller that acquired the admission releases it only after a definitive
Stripe 400 `invalid_request_error`; idempotency conflicts, network errors, 5xx responses, malformed success responses, and errors from an exact replay
leave the shared admission intact. A lapsed account in grace may start a replacement Checkout, while an active,
trialing, or incomplete subscription blocks a second one. An exact retry with the same idempotency key and interval
re-enters Stripe with the same provider idempotency key to recover a lost hosted URL; any other request conflicts until
the admission expires. Stripe documents the request fields and the 30-minute minimum Session expiry in its
[Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create).

## Abuse and cost controls

The Worker has account-keyed Cloudflare Rate Limiting bindings: 600 authenticated API requests, 10 billing session
requests, and 120 download-authority requests per minute. GitHub exchange and refresh are each capped at 30 requests
per minute by route plus Cloudflare connecting IP before JSON parsing, outbound GitHub access, or credential work;
that IP exists only as the limiter key and is never persisted or logged. The public Stripe endpoint is capped at 300
deliveries per minute per Cloudflare location before signature work or logging. These counters are deliberately
enforcement state, not analytics. Cloudflare documents that the binding is permissive and local to a Cloudflare
location, so production must also enable account-level billing notifications and Worker error notifications; a
measured distributed attack would require a stricter global rule, not silent product telemetry.

`STORAGE_ALERT_BYTES` is an aggregate ciphertext-plus-reservation threshold. The scheduled worker emits one
`storage_cost_threshold` warning per day while it is crossed. Per-account quota, rate-limit, accounting-drift, and
grace-deletion warnings use the exception-only schema in ADR 0003. Workers invocation logs and Logpush stay off;
custom logs have the paid plan's seven-day retention.

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

- `POST /v1/auth/github/exchange` rate-limits before verifying a GitHub access token through `/user` and issuing
  Packbat credentials.
- `POST /v1/auth/refresh` rate-limits before credential lookup and rotates a refresh token once.
- `DELETE /v1/auth/credential` revokes the authenticated CLI credential.
- `GET /v1/billing/status` returns `inactive`, `active`, or `grace`, the grace deadline, upload/restore admission,
  and authoritative used/reserved bytes. This is the continuation contract for `packbat cloud link`.
- `POST /v1/billing/checkout` accepts `interval` (`month` or `year`) plus an idempotency key, atomically admits one
  pending Checkout per account, and returns its Stripe-hosted URL. A Stripe Customer ID is created and stored only
  when this endpoint first runs.
- `POST /v1/billing/portal` returns a short-lived Stripe-hosted Customer Portal URL.
- `POST /v1/billing/webhook` is the unauthenticated, signature-verified Stripe lifecycle endpoint.
- `POST /v1/machines` registers an opaque remote machine namespace.
- `POST /v1/uploads/reservations` atomically reserves quota and returns exact-object upload authority. Every request
  carries a sweep ID; an index also declares the sweep's archive count and prior index ETag.
- `POST /v1/uploads/:reservationId/finalize` verifies R2 length and SHA-256 before publishing the ledger entry.
- `POST /v1/downloads` returns short-lived read authority for a committed ciphertext object.
- `DELETE /v1/account` fences every outstanding upload URL, then removes the complete R2 prefix before its D1 rows.
  It returns `202 deletion_pending` with `retryAt` while those fenced URLs finish expiring; retry until `204`.

New accounts are `inactive`: they can authenticate and begin Checkout but cannot register a Cloud machine or reserve
an upload. Only Stripe `active` grants upload admission. Any other status after prior activation starts one 90-day
grace window immediately; no new reservation is admitted, but an operation already admitted through a presigned URL
may finish within its existing five-minute capability window. This bounded in-flight completion avoids destroying a
committed object while revoking a conditional replacement. Issue #41 keeps acceptance of this bounded in-flight
behavior as an explicit human decision; it is implemented behavior, not settled product policy. Committed ciphertext
remains downloadable until the stated deadline. Reactivation inside the window clears grace in place. The five-minute scheduled worker reconciles
expired reservations and used/reserved accounting, then sends expired grace accounts without a live Checkout
admission through the same R2-first deletion cascade as explicit account deletion. The deletion fence atomically
rechecks that grace is still expired and no live admission exists, so a Checkout completed before the deadline can
wait for its Stripe webhook without losing the account.

The migration is a pre-GA hard cut: every existing account becomes `inactive` while its credentials, machine rows,
ledger, reservations, ciphertext, and byte counters are preserved. There is no legacy plan/free entitlement or
fallback path; the account must complete Checkout before another upload is admitted.
