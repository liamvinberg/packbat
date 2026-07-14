# Blotter Cloud architecture

Checked 2026-07-14. This resolves the architecture spike in
[#25](https://github.com/liamvinberg/blotter/issues/25) under the decisions already fixed in
[#15](https://github.com/liamvinberg/blotter/issues/15): Blotter Cloud is optional, E2E-only, and stores
ciphertext only. The age identity never reaches Blotter. User-owned storage stays the default init lane,
and plaintext hosting is permanently out of scope.

## Verdict

| Area | Decision |
| --- | --- |
| Service | Static dashboard plus one small API, D1, and R2 Standard. GitHub supplies browser and device-flow identity. |
| Account | Opaque Blotter user ID linked to a GitHub numeric user ID. No email, password, profile, or GitHub token retained. |
| CLI auth | GitHub's RFC 8628 device flow with no requested OAuth scope, followed by a one-time exchange for Blotter tokens. |
| Upload | Exact-object, short-lived presigned-URL broker behind a Cloud remote adapter. Rclone remains for user-owned remotes. |
| Read | Decrypt each machine's small `index.jsonl.age` first, then fetch and stream one selected session object. |
| Browser key v1 | Choose the existing recovery-kit file locally, with pasted identity as fallback. Keep the identity in page memory only. |
| Browser key later | A WebAuthn PRF passkey encrypts one small X25519 identity envelope. One confirmation unlocks the page session. |
| Store | R2 Standard. B2 is cheaper, but R2 removes egress-cost abuse and keeps the service on one operational stack. |
| Free tier | 10 GB per Cloud account. Plan on **$0.16 per fully used free user per month** at scale. |

The service can truthfully say that stored data is E2E encrypted. It cannot say that a server-delivered web
client remains safe during an active server compromise: malicious dashboard JavaScript can steal a selected or
unwrapped key the next time the user unlocks it.

## Architecture

### Minimal stack

1. A static browser dashboard served on the long-lived production origin.
2. A small API on Cloudflare Workers for Blotter sessions, token exchange, machine registration, quotas, upload
   reservations, and presigning.
3. D1 for the small relational control plane.
4. One private R2 Standard bucket for ciphertext.
5. One GitHub OAuth app with Device Flow enabled. No email sender, password database, queue, telemetry service,
   or analytics SDK is required.

Workers Free currently allows 100,000 requests per day; Workers Paid starts at $5 per account and includes 10
million requests per month. D1 scales to zero and its paid allowance includes 25 billion rows read and 50 million
rows written per month. Those allowances are comfortably above an initial service whose main data plane bypasses
the Worker through presigned R2 URLs. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Do not proxy archive uploads through a Worker. Cloudflare account plans cap request bodies at 100 MB on Free and
Pro, 200 MB on Business, and 500 MB on Enterprise, while an archive object may be multiple gigabytes. Direct
object-store transfer is the large-object path. See
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### Account and device link

Use GitHub as the v1 identity provider. Blotter's first users already live in developer CLIs, and GitHub implements
the RFC 8628 interaction directly: the CLI receives `device_code`, `user_code`, `verification_uri`, `expires_in`,
and `interval`, shows the eight-character code, and polls until approval, denial, or expiry. A device client must
respect `authorization_pending`, permanently add five seconds after `slow_down`, and back off on network timeouts.
Those are protocol requirements, not optional retry polish. See
[RFC 8628 sections 3.2 through 3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.2) and
[GitHub's device-flow contract](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

Flow:

1. `blotter init` offers Blotter Cloud only after the default user-owned-storage lane.
2. On an explicit Cloud choice, the CLI asks GitHub for a device code with the public app client ID and no scope.
   GitHub documents that a CLI does not need to request a scope for authentication. The client secret is not used
   in device flow. See [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
   and [GitHub device-flow errors](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#error-codes-for-the-device-flow).
3. The user approves at `github.com/login/device`. The CLI receives a GitHub access token, uses it only for the
   Blotter exchange, and does not persist it afterwards.
4. The API calls GitHub's authenticated-user endpoint, keys the account by the numeric GitHub ID, issues Blotter
   access and rotating refresh tokens, and immediately discards the GitHub token. It never asks for or stores an
   email. GitHub says to revalidate `/user` after every sign-in. See
   [GitHub's web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow).
5. The dashboard uses the same provider's normal browser flow with `state` and PKCE, then receives a secure,
   HTTP-only Blotter session cookie. Existing Blotter credentials continue to work if GitHub is temporarily down;
   only new browser sign-ins and device links depend on GitHub.

This delegates the low-entropy user-code store, rate limiting, polling, and approval UI to a mature RFC 8628
implementation. If Blotter later needs non-GitHub users or a branded approval screen, it can own the RFC endpoints
then. That is not required for the developer-only v1.

The device code is not an account. It is a short-lived grant linking one CLI to the account that approves it.
Minimal durable state is:

| State | Fields |
| --- | --- |
| User | Opaque `user_id`, GitHub numeric `subject_id`, `created_at`, plan, `quota_bytes`, `used_bytes`, `reserved_bytes`, random storage prefix |
| CLI credential | Credential ID, user ID, refresh-token digest, created/expiry/revoked times |
| Machine remote | User ID, opaque random remote machine ID, created time, current index ETag |
| Object ledger | User ID, machine remote ID, logical object key, bytes, ETag, last completed time |
| Upload reservation | User, object, expected bytes and checksum, replaced bytes, idempotency key, expiry, state |
| Billing | Provider customer ID only after the user actually starts a paid plan |

Do not retain the GitHub access token, email, name, avatar, organization membership, device profile, age recipient,
age identity, recovery kit, session title, harness inventory, or product-usage events. GitHub login is display data,
not identity; the numeric subject is the stable join key.

### Cloud is a managed remote

[#18](https://github.com/liamvinberg/blotter/issues/18) should make the seam semantic, not rclone-shaped. Each remote
needs logical operations such as `exists`, `put archive objects`, `put index`, `get index`, and `get archive object`.
User-owned remotes implement those operations with rclone. Cloud implements them with its API and direct HTTP
transfers.

The Cloud adapter preserves the current sweep contract in
[`outbox.ts`](../../apps/cli/src/offbox/outbox.ts):

1. Local state decides which archive files are newer.
2. Encrypt and publish every changed `<file>.age` object.
3. Only after all changed objects finalize, publish `index.jsonl.age` last.
4. On the first publish, refuse to claim an existing remote machine index.
5. Record success for Cloud independently. A failure must not block another configured remote.

The encrypted index is the readiness pointer: if it names an object, that object must already be committed. Cloud
may skip an index upload when the plaintext index has not changed. Today's publisher re-encrypts and uploads the
index on every hourly sweep, but age encryption is randomized, so this creates a Class A write and leaks an online
timestamp without changing the recoverable set.

Recommended R2 key shape for v1:

```text
users/<opaque-storage-id>/machines/<opaque-remote-machine-id>/<harness-id>/<archive-relative-path>.age
users/<opaque-storage-id>/machines/<opaque-remote-machine-id>/index.jsonl.age
```

The opaque machine namespace is generated during Cloud registration and is not the hostname. The encrypted index
already contains the real machine and harness provenance needed after unlock. Keep the user ID and machine name out
of R2 keys and custom metadata.

### Upload-leg decision

| Option | Multi-remote fit | Credential blast radius | Quota boundary |
| --- | --- | --- | --- |
| Rclone with scoped S3 credentials | Reuses today's transport, but makes Cloud depend on rclone configuration and hidden list/comparison behavior. | Durable R2 tokens are bucket-scoped. R2's 2026 temporary credentials can be path- and action-scoped, but still grant several operations until expiry. | R2 has no per-prefix quota. Direct credentials let a client write around per-object admission during their lifetime. |
| Presigned-URL broker | Cloud is a first-class adapter while own-storage remotes keep rclone. Simple data transfer is an ordinary HTTP request. | One method on one object for a short time. Parent R2 credentials never reach the CLI. | Every write begins at the broker, where D1 can atomically reserve bytes and order the index after archive objects. |
| Thin native S3 uploader | Avoids rclone, but the CLI must own SigV4, temporary credentials, multipart, retries, and resume. | Wider than one presigned operation unless reduced to exact-object credentials, at which point it recreates the broker. | Still needs server reservations and completion; S3 credentials do not create a tenant quota. |

**Recommendation: presigned-URL broker.** Cloudflare describes presigned URLs as authority for one operation on one
object, while temporary credentials cover several operations over a bucket, path, or object set. That distinction
matches the trust boundary here. See
[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) and
[R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

Teach-back: rclone is the right abstraction when the user owns both the remote and the credential risk. In a shared
managed bucket, Blotter owns tenant isolation and quota. A short-lived S3 credential says what a client may do for a
period; a presigned URL says this one operation may touch this one object. The second is a smaller failure domain and
puts admission exactly where the service can account for it.

### Quota and upload protocol

R2 has no per-prefix storage limit. A 10 GB product quota therefore needs a service ledger and an upload protocol:

1. The CLI sends machine remote ID, logical key, ciphertext length, ciphertext checksum, and idempotency key to an
   upload-reservation endpoint.
2. One conditional D1 update checks
   `used_bytes + reserved_bytes - replaced_bytes + new_bytes <= quota_bytes` and reserves the admitted bytes.
3. The API chooses the only allowed R2 key and returns upload authority that expires in roughly five minutes.
4. The CLI uploads directly to R2. The API verifies stored length and checksum, then atomically converts reserved
   bytes to used bytes and records the ETag.
5. Expired reservations are released. An index reservation is refused until every changed archive object in that
   sweep is complete. The first index commit is conditional on absence; later commits use the expected prior ETag
   so two machines cannot silently clobber one logical machine.

A plain presigned PUT is not yet a proven hard quota. Cloudflare documents signing `Content-Type`, but does not
document `Content-Length` as an enforced upper bound, and a presigned URL is reusable until expiry. Before build,
prove that R2 rejects a length different from the signed value. If it does not, the service must retain multipart
completion authority: reserve the total, presign bounded parts, verify actual part sizes, and only let the service
complete the object. R2 supports objects up to 5 TiB and bills multipart create, parts, and completion as Class A.
See [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).

This proof is a launch blocker for quota enforcement, not a reason to proxy plaintext or ciphertext through the API.

## Browser decrypt proof

The isolated proof is in [`.scratch/wayfinder-v2/cloud-spike/`](../../.scratch/wayfinder-v2/cloud-spike/). Its
`package.json` pins `age-encryption@0.3.0`; `npm install` was run in that directory only.

Important files:

- [`proof.mjs`](../../.scratch/wayfinder-v2/cloud-spike/proof.mjs) generates a synthetic index, an X25519
  `AGE-SECRET-KEY-1...` identity, and the same `age1...` recipient shape that the CLI uses, then encrypts and checks
  both buffered and streamed decryption.
- [`browser-decrypt.mjs`](../../.scratch/wayfinder-v2/cloud-spike/browser-decrypt.mjs) is the decrypt path. It has no
  Node imports and uses only typage plus `ReadableStream`, `Response`, `TextEncoder`, and `TextDecoder` web APIs.
- [`streaming-proof.mjs`](../../.scratch/wayfinder-v2/cloud-spike/streaming-proof.mjs) moves 256 MiB through streaming
  encryption and decryption without constructing the whole input or output.
- [`results.md`](../../.scratch/wayfinder-v2/cloud-spike/results.md) records exact commands and outputs.

What ran:

```text
npm run proof
plaintext 229 bytes -> ciphertext 429 bytes
Uint8Array decrypt: ok
Response.body stream decrypt: ok

npm run proof:stream
plaintext/decrypted: 256 MiB
elapsed: 2,863 ms
peak JS heap: 15.0 MiB
peak RSS: 188.3 MiB
peak ArrayBuffer memory: 66.7 MiB
result: ok
```

The memory figures describe one Node v26.3.0 run, not a browser guarantee. The API and source establish the memory
shape:

- `Decrypter.decrypt(Uint8Array)` consumes the output with `readAll` and returns a complete `Uint8Array`. This is
  buffer-oriented and memory grows with the object.
- `Decrypter.decrypt(ReadableStream<Uint8Array>)` parses and authenticates the age header, then returns a decrypted
  web stream. The payload transform holds one 64 KiB ciphertext chunk plus its 16-byte authentication tag.

See typage v0.3.0's
[`Decrypter` implementation](https://github.com/FiloSottile/typage/blob/v0.3.0/lib/index.ts#L277-L309),
[`STREAM` implementation](https://github.com/FiloSottile/typage/blob/v0.3.0/lib/stream.ts#L1-L49), and
[browser documentation](https://github.com/FiloSottile/typage/blob/v0.3.0/README.md#browser-usage).

### Dashboard read path

1. Authenticate the Cloud account. Do not ask for the recovery kit yet.
2. List opaque machine remotes and request a short-lived GET URL for each encrypted index.
3. On unlock, parse the selected recovery-kit file locally, create an X25519 `Decrypter`, and decrypt each small
   `index.jsonl.age`. Buffering the index text is intentional because the index is the small navigation structure.
4. Merge decrypted index records in page memory and render the archive list.
5. Only after a user selects a session, request that object's GET URL and pass `response.body` directly to typage.
6. Pipe the decrypted `.zst` bytes through a streaming zstd decoder, incremental UTF-8/JSONL parsing, and a bounded
   or virtualized renderer. Never call `arrayBuffer()`, `blob()`, or `text()` on this large-object path.

Index-first and lazy fetch make the ordinary case small. They do not make a selected multi-gigabyte session small.
Age is now proven stream-capable, but the whole claim still requires a cross-browser proof of streaming zstd,
incremental parsing, backpressure, and rendering. Typage's public API is sequential, so random access into one age
object is not available.

If a supported browser exposes zstd through `DecompressionStream`, use it behind feature detection. Otherwise a
streaming WASM decoder is required. The dashboard ticket must measure the complete fetch -> age -> zstd -> parser
pipeline before claiming multi-GB readiness.

## Browser key UX

| Option | Security | Usability | Verdict |
| --- | --- | --- | --- |
| Paste identity | Works with current objects, but exposes the identity to clipboard history and makes formatting mistakes easy. | Lowest implementation cost; repeated manual action. | Fallback in v1. |
| Choose recovery-kit file | Works with current objects and avoids the clipboard. A normal file input reads it locally without sending it to Blotter. | Reuses the artifact the user already safeguards. | **Default in v1.** |
| WebAuthn PRF | No extractable PRF secret, but origin-bound, experimental in typage, and every direct typage PRF encryption/decryption requires user verification. | Convenient after enrollment, with authenticator confirmation. | Later convenience unlock. |

V1 copy must say that choosing the recovery kit does not upload it. Extract the identity in browser memory, clear the
reference on lock or navigation, and never put it in LocalStorage, IndexedDB, service-worker caches, logs, error
reports, analytics, or an API request. JavaScript garbage collection cannot promise immediate zeroization, so do
not claim that it can.

Typage's WebAuthn recipient is symmetric and uses the credential PRF to wrap each age file key. It sets user
verification to required, and its README states that every encryption and decryption operation needs authenticator
confirmation. A WebAuthn identity cannot decrypt the current X25519 ciphertext. See
[typage's passkey documentation](https://github.com/FiloSottile/typage/blob/v0.3.0/README.md#encrypt-and-decrypt-a-file-with-a-passkey),
[`webauthn.ts`](https://github.com/FiloSottile/typage/blob/v0.3.0/lib/webauthn.ts#L91-L118), and the
[WebAuthn PRF standard](https://www.w3.org/TR/webauthn-3/#prf-extension).

The later design is therefore a wrapper, not a new archive recipient:

1. While the user has the recovery kit selected, create a PRF-capable passkey for the final production RP ID.
2. Encrypt only the X25519 identity into a tiny typage WebAuthn ciphertext envelope.
3. Store that envelope and the non-secret credential/RP hint in Cloud.
4. On a future dashboard visit, one authenticator confirmation decrypts the envelope. The page holds the recovered
   X25519 identity in memory and uses it for all selected archive objects until lock.

Directly encrypting every archive object to the passkey would require an authenticator operation during each
unattended CLI upload and another tap per browser object. That breaks turnkey backup. The recovery kit remains the
canonical recovery route even after passkey enrollment; Cloud cannot reset an age identity.

## Threat model

### Passive server snapshot

A compromise of the API database, R2 bucket, secrets, and configured logs yields:

- Every encrypted session object and encrypted index.
- Account state: GitHub numeric subject, opaque Blotter and storage IDs, plan/quota, hashed credentials, machine
  remote IDs, object ledger, and pending reservations.
- Object keys, object count, exact ciphertext byte sizes, ETags/checksums, storage class, upload/last-modified times,
  and any HTTP or custom metadata. R2 exposes those fields on its object model. See the
  [R2 object definition](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2object-definition).
- Access patterns retained by application or provider logs: account, network endpoint, requested object, time, and
  transferred bytes.

Under a naive user prefix plus today's remote tree, keys expose the machine hostname, harness ID, original archive
relative filenames, session IDs, date-shaped paths, and which object is the index. Under the recommended v1 key
shape, the real machine name is replaced by a random remote machine ID, but harness IDs and relative filenames
remain visible. Ciphertext size closely tracks compressed plaintext size plus small age overhead. Replacement and
index timestamps reveal activity cadence.

The snapshot does not contain the age identity, session plaintext, decrypted index fields, or exact uncompressed
size. It cannot decrypt stored objects from Blotter data alone.

### Active server compromise

An active attacker can delete, withhold, overwrite, or replay valid old ciphertext. Age authenticates the file it is
given but does not prove that the set is complete or current. A replayed older encrypted index may decrypt cleanly.

More importantly, control of the dashboard origin lets the attacker serve JavaScript that exfiltrates the selected
recovery kit, pasted identity, passkey-unwrapped identity, or plaintext during the next unlock. E2E protects a stored
snapshot; it does not make mutable server-delivered code trusted. A pinned local client or separately verifiable
signed web bundle could narrow this later, but v1 must state the limit plainly.

### Metadata minimization

Worth doing in v1:

- Random opaque user storage prefix and random remote machine ID. Never use GitHub ID, email, or hostname in a key.
- Generic `application/octet-stream`; no `Content-Disposition`, original filename, harness, recipient, or source
  mtime in HTTP/custom metadata.
- No product analytics. Never log object keys, presigned URLs, request bodies, recovery material, or decrypted data.
- Upload the encrypted index only when its plaintext changed. Preserve index-last ordering without an hourly
  randomized rewrite.
- Short retention and redaction for the minimum security and abuse logs that operation requires. Provider-level
  request metadata cannot honestly be called nonexistent.

Worth a later privacy ticket before claiming metadata-private storage:

- Opaque stable object IDs with logical path mapping inside an encrypted Cloud catalog. The API must receive only
  opaque IDs too; hiding an R2 key while logging the plaintext path is cosmetic.
- An encrypted account-level catalog if machine count and machine-to-index linkage also need hiding.

Not worth v1 complexity:

- Padding every ciphertext. It multiplies storage cost while update timing and access patterns still leak.
- ORAM-like access hiding or proxying every read. It conflicts with direct transfer and reintroduces service
  bandwidth and large-body limits.
- Claiming upload times can be hidden. The object store necessarily records when a write occurs.

## Storage and free-tier cost

### Provider comparison

Prices checked 2026-07-14 against first-party pages.

| Meter | R2 Standard | Backblaze B2 |
| --- | ---: | ---: |
| Storage | $0.015/GB-month | $6.95/TB-month, about $0.00695/GB-month |
| Included storage | 10 GB-month per provider account | First 10 GB per provider account |
| Writes | Class A: $4.50/million, first 1 million included | Current Class A/B/C transactions free |
| Reads | Class B: $0.36/million, first 10 million included | Current Class A/B/C transactions free |
| Egress | Free | Free to 3x average stored bytes, then $0.01/GB |

Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[B2 pricing](https://www.backblaze.com/cloud-storage/pricing), and
[B2 transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing).

Some older Backblaze help pages still show superseded storage and transaction rates. Confirm the billable product
terms before implementation; the table uses the current product and transaction pages linked above.

The headline 10 GB allowances belong to Blotter's provider account. They are not granted again for every user in a
shared bucket. A 10 GB free plan becomes Blotter's subsidy after the first aggregate 10 GB.

B2 is the raw cost winner while a user downloads less than 3x their stored bytes. R2 is the v1 recommendation
because unlimited egress removes an abuse and restore-cost dimension, presigned transfers and the control plane live
on the same platform, and the absolute difference is about 8.6 cents per fully used user-month. Revisit B2 when
storage cost, not operational simplicity or egress risk, becomes the measured constraint.

### Workload and number that matters

The executable model is [`cost-model.mjs`](../../.scratch/wayfinder-v2/cloud-spike/cost-model.mjs). Assumptions:

- 10 GB average stored ciphertext for a fully used account.
- One machine.
- 720 hourly sweeps in a 30-day month, conservatively retaining today's index write on every sweep.
- 300 changed archive-object writes per month.
- One finalization HEAD per upload, 30 dashboard index reads, and 100 session reads per month.
- Single-part objects in the base number. Multipart adds Class A create, part, and complete calls.

That is 1,020 Class A and 1,150 Class B operations per full user-month. Marginal cost before shared allowances:

```text
storage: 10 GB * $0.015                         = $0.150000
Class A: 1,020 * $4.50 / 1,000,000             = $0.004590
Class B: 1,150 * $0.36 / 1,000,000             = $0.000414
total                                                $0.155004
```

Cloudflare rounds billable storage and operation quantities up to billing units. Cohort outputs from the model:

| Fully used users | R2 total/month | R2 per user | B2 total before paid egress | B2 per user |
| ---: | ---: | ---: | ---: | ---: |
| 1 | $0.00 | $0.00 | $0.00 | $0.00 |
| 100 | $14.85 | $0.1485 | $6.8805 | $0.068805 |
| 1,000 | $154.35 | $0.15435 | $69.4305 | $0.06943 |
| 10,000 | $1,545.57 | $0.154557 | $694.9305 | $0.069493 |

Plan with **$0.16 per fully used 10 GB free user per month** for R2 storage and operations. The $5 Workers Paid
minimum, if required, adds $0.005 per user at 1,000 users and $0.0005 at 10,000. Billing, support, tax, and abuse
headroom are outside this storage COGS figure. Uploading the index only when it changes will remove most Class A
churn, but storage remains the dominant cost.

## Proposed invariant ADR

Status: **proposed for maintainer review**. This document does not edit `CLAUDE.md`, `AGENTS.md`, or the bank.

### Context

The current invariant forbids any hosted service or account. Map #15 now fixes a narrower position: the core and
user-owned remote require no account, while optional Blotter Cloud may exist only as a ciphertext store whose key
never reaches Blotter. The dashboard performs read-time decryption on the user's client. Plaintext hosting and key
escrow are not future options.

### Decision

Replace the current `CLAUDE.md` invariant bullet exactly with:

> - **Local-first, no required account.** User-owned storage remains the default off-box lane. Every off-box copy is
>   encrypted before leaving the machine with a key only the user holds. Optional Blotter Cloud stores ciphertext
>   only and decrypts client-side; the key never reaches Blotter, plaintext hosting and key escrow are permanently
>   out of scope, and there is no telemetry.

Apply the same wording to the mirrored project invariant in `AGENTS.md` during ADR review.

Proposed bank decision-6 revision note:

> **2026-07-14 revision:** Blotter Cloud is GO now, E2E-only. Blotter stores ciphertext only; the key never leaves
> the user; the dashboard decrypts client-side; user-owned storage remains the default init lane; plaintext hosting
> and key escrow are permanently out of scope; there is no telemetry. This supersedes the 2026-07-12 demand-pull
> timing gate. It does not revise the free/OSS core or make a Cloud account required. Pricing and monetization remain
> separate decisions.

### Consequences

- Any feature that requires Blotter to receive an age identity or session plaintext is rejected by invariant, not
  deferred.
- Cloud auth, quota, and billing data must remain separate from archive contents and minimized to what operating the
  optional service requires.
- Client-side decryption does not excuse active web-client risk. The product must not overstate what E2E protects.
- User-owned remotes stay first in init and keep working without any Cloud account or service availability.
- Product telemetry remains prohibited. Required security and abuse logging needs an explicit minimal schema and
  retention decision; it cannot silently become behavioral analytics.

## Proposed build tickets for map #15

These are proposals for the maintainer to file. This spike does not create or edit GitHub issues.

### Blotter Cloud: GitHub account and device-link service

Implement the optional Cloud account boundary using GitHub's RFC 8628 device flow for the CLI and GitHub's browser
OAuth flow with state and PKCE for the dashboard. Exchange the provider token once for Blotter access plus rotating
refresh credentials, retain only the GitHub numeric subject and minimal account state, expose credential revocation
and account deletion, and store no email, provider token, profile, archive recipient, or recovery material.
Dependencies: #25 accepted, invariant ADR reviewed.

### Blotter Cloud: R2 ciphertext broker and hard quota

Create the minimal Worker, D1 schema, and private R2 Standard bucket contract for opaque user/machine prefixes,
object ledgers, atomic byte reservations, short-lived exact-object PUT/GET authority, checksum/size finalization,
conditional first index publication, and archive-first/index-last ordering. First prove signed byte-length enforcement
or server-controlled multipart completion against real R2; the ticket is not done while an authenticated client can
exceed its reserved quota. Dependencies: account/device-link service.

### CLI: add Blotter Cloud as a managed remote

Add Cloud as one entry on #18's remote list, authenticate through the device-link flow, and implement the Cloud
adapter without exposing an age identity or R2 credential. Reuse local change detection, upload changed ciphertext
objects before the encrypted index, preserve the first-publish clobber guard, report Cloud health independently in
status/doctor, and keep user-owned storage as the default wizard lane. Dependencies: #18, account/device-link
service, R2 ciphertext broker.

### Blotter Cloud: E2E dashboard v1

Build the authenticated ciphertext dashboard with recovery-kit file selection as the default unlock, pasted identity
as fallback, small index-first decryption, lazy presigned session fetch, typage `ReadableStream` decryption,
streaming zstd/incremental parsing, and a bounded renderer. The key and plaintext must stay in page memory only and
never enter persistence, logs, errors, or requests. Include cross-browser and multi-GB memory proofs and state the
active-compromised-frontend limit in product copy. Dependencies: account/device-link service, R2 ciphertext broker,
and #19 where its retrieval contract affects index presentation.

### Blotter Cloud: plan enforcement, billing, and abuse controls

Ship the 10 GB free entitlement, authoritative used/reserved-byte accounting, request and download abuse limits,
reservation reconciliation, billing-provider IDs only for paid accounts, and cost/limit alerts without product
telemetry. Pricing and paid-plan UX remain blocked on the maintainer's productization verdict; quota correctness and
cost protection do not. Dependencies: R2 ciphertext broker; paid billing additionally depends on the pricing verdict.

### Blotter Cloud: passkey-wrapped dashboard unlock

After dashboard v1, add optional typage WebAuthn PRF enrollment that encrypts one X25519 identity envelope and uses
one authenticator confirmation per dashboard unlock. Keep the recovery kit canonical, feature-detect PRF support,
test the browser/authenticator matrix, and fix the production RP ID before enrolling credentials. Dependencies: E2E
dashboard v1; not a launch blocker.

## Open questions and launch proofs

1. Does the chosen R2 signing implementation enforce a signed `Content-Length`, or must all hard-quota uploads use
   server-controlled multipart completion?
2. What client-held freshness mechanism detects a replayed old but valid encrypted index after a server compromise?
   Age authenticates content, not recency or set completeness.
3. Does the complete browser pipeline stream zstd and JSONL with bounded memory across the supported browser matrix,
   not just the age layer proven here?
4. Are plaintext harness IDs and relative filenames acceptable Cloud metadata for v1, or must opaque object IDs and
   an encrypted catalog block launch?
5. What exact security/abuse log fields and short retention are operationally required while still satisfying the
   no-telemetry invariant?
6. Is GitHub-only identity acceptable for optional Cloud v1? If not, owning RFC 8628 plus email authentication adds
   an email provider, address storage, recovery policy, and a larger account surface.
7. At what measured scale or restore pattern should B2's roughly 8.6-cent storage advantage outweigh R2's unlimited
   egress and single-stack operation?
