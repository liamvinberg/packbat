# R2 signed Content-Length proof

Checked 2026-07-16 against the private `packbat` Cloudflare R2 Standard bucket. The bucket uses the Eastern Europe
location hint and the default R2 S3 endpoint. The proof used the production broker dependency, `aws4fetch`, through
[`prove-r2-content-length.mjs`](../../apps/cloud/scripts/prove-r2-content-length.mjs).

## Result

```text
┌─────────┬───────────────────────────────────┬────────────┬───────────────────────┐
│ (index) │ case                              │ objectSize │ status                │
├─────────┼───────────────────────────────────┼────────────┼───────────────────────┤
│ 0       │ 'matching header and body'        │ 5          │ 200                   │
│ 1       │ 'changed signed header'           │ null       │ 403                   │
│ 2       │ 'body longer than signed length'  │ 5          │ 200                   │
│ 3       │ 'body shorter than signed length' │ null       │ 'connection rejected' │
└─────────┴───────────────────────────────────┴────────────┴───────────────────────┘
result: signed Content-Length is a hard upper bound
```

The control PUT stored exactly five bytes. Changing the signed `Content-Length` invalidated the signature and stored
nothing. Sending six body bytes while retaining the signed five-byte header stored only five bytes. Sending four
bytes caused a framing rejection and stored nothing. The script removed every synthetic object in its `finally`
block.

## Decision

The exact-object presigned PUT remains the Cloud upload path. R2 enforced the signed `Content-Length` as a hard upper
bound, so an authenticated client cannot use one admitted reservation to store more bytes than D1 reserved. The
server-controlled multipart fallback is not required for GA.

Re-run this proof before changing the signer, HTTP transfer implementation, R2 provider, or upload protocol.
