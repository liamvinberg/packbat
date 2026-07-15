# OAuth destinations

Research date: 2026-07-14. Live validation: 2026-07-15. Console labels and provider policy are current as of those
dates. Credential and token material is deliberately excluded from this artifact.

## Recommendation

| Provider | Verdict | Why | Release boundary |
| --- | --- | --- | --- |
| Google Drive | **Go, conditional on the scheduled durability gate** | The live Desktop client requested only `drive.file`; an In-production grant completed publish, restore, and forced refresh through Packbat's managed rclone config. | Do not merge the public wizard lane until the same 2026-07-15 grant passes the scheduled July 23 refresh/restore probe and its follow-up revoke/reauthorize check. Publish verified branding before public onboarding. |
| Dropbox | **Go for early adopters** | The App Folder boundary, minimum rclone permissions, publish/restore, forced refresh, UI revocation, reauthorization, and retained-data restore all passed live. | Treat the bundled app secret as public client metadata, not a security boundary. Resolve PKCE or obtain Dropbox approval for rclone's current secret-based flow before the shared app reaches user 50. |

This resolves the provider choice for the wizard: both lanes work, but only Dropbox is lifecycle-complete today. Google
remains blocked from implementation by a real-time durability gate, not by an unknown design decision.

## Live validation status

Live validation began on 2026-07-15 against Google Cloud project `test-project` and Dropbox app
`packbat-oauth-spike-liam`. Credential material is stored outside the repository under `~/.packbat/oauth-spike/` in
mode-`0600` files. The managed scratch rclone config is also mode `0600`; no token, client secret, or authorization URL
is recorded in this document.

| Provider | Current verdict | Live evidence | Remaining gate |
| --- | --- | --- | --- |
| Google Drive | **Functional go; durability pending** | External app published **In production**; Desktop client; only `drive.file`; consent matched that scope; three synthetic archives plus one index round-tripped byte-for-byte; forced access-token expiry refreshed successfully. | The exact grant is scheduled to repeat refresh/restore on 2026-07-23 at 18:00 Europe/Stockholm. Revoke and reauthorize after that pass. Brand verification remains a public-onboarding gate. |
| Dropbox | **Go for functional and authorization lifecycle** | App Folder app; documented minimum scopes; `http://localhost:53682/` redirect; consent was confined to `/Apps/packbat-oauth-spike-liam`; the synthetic round-trip and forced refresh passed; UI revocation produced rclone `invalid_grant` and exit `1`; reauthorization restored the original remote bytes without moving or deleting data. | Resolve the public-client/PKCE production shape before the shared app crosses its approval threshold. |

The live scripts ran as `packbat-drive-spike` and `packbat-dropbox-spike`. Both used the exact invocations in this
document through the scratch config. Google intentionally skipped revocation so the same grant can establish the
seven-day result.

## Google Drive registration runbook

The intended production shape is an External Google Auth Platform application, one Desktop OAuth client, and only
`https://www.googleapis.com/auth/drive.file`.

1. Open the Google Cloud [API Library](https://console.cloud.google.com/apis/library), select or create the production
   project, find **Google Drive API**, and click **Enable**. Google's installed-app guide documents the same
   select/create project, select API, and Enable sequence
   ([Google: enable APIs](https://developers.google.com/identity/protocols/oauth2/native-app#enable-apis)).
2. Open **Google Auth Platform > Branding** and click **Get Started**. Enter the app name and user-support email.
   Choose **External** under Audience so consumer Google Accounts can authorize it, enter the developer-contact email,
   accept the Google API Services User Data Policy, and create the app. Google documents these fields and distinguishes
   External from organization-only Internal apps
   ([Google: configure OAuth consent](https://developers.google.com/workspace/guides/configure-oauth-consent#configure_oauth_consent)).
3. While the app is in Testing, open **Audience > Test users > Add users** and add only the account used for the live
   spike. Testing projects are limited to 100 listed test users
   ([Google: app audience](https://support.google.com/cloud/answer/15549945#publishing-status)).
4. Open **Data Access > Add or Remove Scopes**, add exactly
   `https://www.googleapis.com/auth/drive.file`, and save. Drive scopes must be declared both in Data Access and in the
   authorization request; `drive.file` is currently classified non-sensitive
   ([Google: Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth#configure_oauth_20_for_authorization),
   [Google: non-sensitive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth#non-sensitive)).
5. Open **Clients > Create Client**, choose application type **Desktop app**, give it an identifying name, and click
   **Create**. The Desktop form needs no manually registered redirect URI
   ([Google: create Desktop credentials](https://developers.google.com/workspace/guides/create-credentials#desktop),
   [Google: manage OAuth clients](https://support.google.com/cloud/answer/15549257)). Save the displayed client ID and
   one-time-visible client secret in the project's secret-management system, never in this repository. Google treats
   installed apps as public clients that cannot keep a client secret confidential
   ([Google: installed-app overview](https://developers.google.com/identity/protocols/oauth2/native-app#overview)).
6. Run the rclone local-webserver flow in the live-leg script. A Desktop client is the correct client type for a system
   browser plus loopback listener; Google recommends the loopback-IP redirect for macOS, Linux, and Windows desktop apps
   ([Google: loopback redirect](https://developers.google.com/identity/protocols/oauth2/native-app#redirect-uri_loopback)).
7. After the test consent and copy/restore pass, open **Audience** and click **Publish app** to change publishing status
   to **In production**. Do not ship with Testing status: authorization by a test user expires seven days after consent,
   including an offline refresh token, because `drive.file` is outside the profile-only exception. In-production apps
   are available to any Google Account and are not subject to that Testing-only seven-day expiry
   ([Google: app audience](https://support.google.com/cloud/answer/15549945#publishing-status)).

### Publishing unverified versus brand verification

`drive.file` is a non-sensitive scope and Google says non-sensitive-only applications do not need sensitive or
restricted scope verification. Personal-use and development apps have generic verification exceptions
([Google: verification exceptions](https://support.google.com/cloud/answer/13464323),
[Google: Drive scope classification](https://developers.google.com/workspace/drive/api/guides/api-specific-auth#non-sensitive)).
Publishing the app to In production is therefore the path that removes the Testing token expiry while the brand review
is pending. This is not the finished public launch state: without brand verification, Google displays the application
domain rather than the configured app name/logo
([Google: brand verification](https://support.google.com/cloud/answer/15549049#brand-verification)).
Google ties the 100-user unverified-app cap and warning to unapproved sensitive or restricted scopes. A request limited
to `drive.file` should not enter that lane; the live consent screen still needs to prove it
([Google: app audience and user cap](https://support.google.com/cloud/answer/15549945#oauth-user-cap)).

For the proper shared Packbat client, complete the lighter brand-verification lane:

1. Host a public app homepage on a domain Packbat controls. It must identify and describe Packbat. Host a privacy policy
   on the same domain that explains how Google user data is accessed, used, stored, and shared. Put the homepage,
   privacy-policy URL, optional terms URL, support email, and developer-contact email in **Branding**
   ([Google: brand requirements](https://support.google.com/cloud/answer/13464321#brand-verification-requirements)).
2. Add every domain used by the consent-screen links under **Authorized domains** and verify ownership in Google Search
   Console using an account that is an Owner or Editor of the Cloud project
   ([Google: authorized domains](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#authorized-domains)).
3. Open **Branding** and click **Verify Branding**. Automatic evaluation may complete in minutes; an indeterminate or
   failed result can enter manual review. Google's general estimate for brand verification is 2 to 3 business days
   ([Google: trigger brand verification](https://support.google.com/cloud/answer/15549049#trigger-verification),
   [Google: verification timing](https://support.google.com/cloud/answer/13463817#verification-process)).
4. When the status becomes **Ready to publish**, click **Publish branding** within seven days or the successful result
   expires and must be repeated
   ([Google: publish branding](https://support.google.com/cloud/answer/15549049#publish-your-brand)).

Brand verification and data-access verification are separate statuses. `drive.file` does not trigger the
sensitive/restricted-scope or security-assessment lanes
([Google: verification statuses](https://support.google.com/cloud/answer/15549049#branding-and-data-access-scope-verification),
[Google: minimum scopes](https://support.google.com/cloud/answer/13807380)).

## Dropbox registration runbook

1. Sign in to the [Dropbox App Console](https://www.dropbox.com/developers/apps), click **Create app**, choose
   **Scoped access > Dropbox API**, choose **App folder**, supply the globally unique app name, and create the app.
   App Folder restricts the app's scoped actions to its dedicated `/Apps/<app-name>` folder; Dropbox recommends the
   least-privileged content-access type
   ([Dropbox: OAuth guide](https://developers.dropbox.com/oauth-guide),
   [Dropbox: developer guide](https://www.dropbox.com/developers/reference/developer-guide),
   [rclone: create a Dropbox app](https://rclone.org/dropbox/#get-your-own-dropbox-app-id)).
2. On **Permissions**, enable `account_info.read`, `files.metadata.write`, `files.content.write`,
   `files.content.read`, and `sharing.write`. The console also selects `files.metadata.read` and `sharing.read`. Click
   **Submit**. This is rclone's documented minimum permission set
   ([rclone: Dropbox permissions](https://rclone.org/dropbox/#get-your-own-dropbox-app-id)).
3. On **Settings**, add the exact OAuth2 redirect URI `http://localhost:53682/`. Keep the trailing slash. Dropbox
   requires the redirect URI in the authorization request to exactly match a registered URI, and rclone documents this
   literal value for a custom Dropbox app
   ([Dropbox: redirect matching](https://developers.dropbox.com/oauth-guide),
   [rclone: Dropbox redirect URI](https://rclone.org/dropbox/#get-your-own-dropbox-app-id)). Rclone's browser link may
   show the equivalent loopback listener as `http://127.0.0.1:53682/`; do not substitute that value in the App Console
   unless the installed rclone live leg proves the provider sends it as `redirect_uri`
   ([rclone: Dropbox configuration](https://rclone.org/dropbox/#configuration)).
4. Still on **Settings**, copy the **App key** and reveal/copy the **App secret** into the project's secret-management
   system. In rclone these are `client_id` and `client_secret`, respectively
   ([rclone: Dropbox app credentials](https://rclone.org/dropbox/#get-your-own-dropbox-app-id)). Never place them in
   the recovery kit, this document, a test fixture, or command output committed to the repository.
5. The new app begins in development status and initially links only its owner's account. Use **Enable additional
   users** when the live spike is ready to test another account. A development app can link at most 500 users. At 50
   linked users a two-week window starts in which the app must apply for and receive production approval; otherwise new
   links freeze, and unlinking users does not unfreeze them. Dropbox normally reviews at 50 users, although an earlier
   submission can be considered with compelling evidence. Approved production apps have no linked-user cap
   ([Dropbox: development and production status](https://www.dropbox.com/developers/reference/developer-guide)).

The ticket's phrase “development mode covers early adopters” is correct, but “production review opens at 50” is
incomplete. The actionable boundary is a deadline triggered at user 50, not a 50-user development cap.

### Public-client and PKCE verdict

Dropbox recommends PKCE whenever an application cannot keep its client secret secure and explicitly includes desktop
and open-source applications in that category. Rclone `v1.74.4` does not implement PKCE in its shared OAuth utility:
its Dropbox backend supplies a client ID and client secret, constructs an ordinary authorization-code request, and
exchanges the returned code without a `code_verifier`. Rclone's current official custom-app runbook nevertheless tells
users to register and distribute exactly an App key and App secret, and the live Packbat app completed that flow.
([Dropbox: PKCE guidance](https://developers.dropbox.com/oauth-guide#implementing-pkce),
[rclone: Dropbox app credentials](https://rclone.org/dropbox/#get-your-own-dropbox-app-id),
[rclone: OAuth exchange](https://github.com/rclone/rclone/blob/v1.74.4/lib/oauthutil/oauthutil.go#L908-L919)).

The result is a functional **go for early adopters**, not a claim that an embedded secret is secret. Packbat must treat
the shared Dropbox client secret as public metadata and keep the actual user refresh token only in its mode-`0600`
managed config. Before user 50, either rclone must gain PKCE for this backend or Dropbox production review must accept
the current rclone authorization shape. That approval question is a production-readiness follow-up, not a reason to
discard the proven App Folder lane.

## Rclone invocations for the wizard

Rclone accepts backend options as `key value` or `key=value` pairs on `config create`. When questions remain and
`--non-interactive` is absent, it takes their defaults; `--non-interactive` instead exposes a JSON state machine for an
embedding application
([rclone: `config create`](https://rclone.org/commands/rclone_config_create/)). The wizard's simplest lane is therefore
a command with every material backend option supplied, followed only by the unavoidable system-browser consent.

The following invocations were syntax-validated against the installed rclone `v1.74.4` with fake client values and
`--config` fixed to `.scratch/wayfinder-v2/oauth-spike/rclone.conf`. The dry runs stopped at rclone's OAuth state or
loopback listener and never completed provider authorization. The redacted record is in
[`validation.md`](../../.scratch/wayfinder-v2/oauth-spike/validation.md).

```sh
RCLONE=/opt/homebrew/bin/rclone
RCLONE_CONFIG="$PACKBAT_HOME/rclone.conf"

# Google Drive. The remaining interaction is the browser consent.
"$RCLONE" config create packbat-drive drive \
  client_id "$GOOGLE_CLIENT_ID" \
  client_secret "$GOOGLE_CLIENT_SECRET" \
  scope drive.file \
  config_is_local true \
  config_change_team_drive false \
  --obscure \
  --no-output \
  --config "$RCLONE_CONFIG"

# Dropbox App Folder. App Folder access and action scopes are properties of the
# Dropbox app, not extra rclone configuration fields.
"$RCLONE" config create packbat-dropbox dropbox \
  client_id "$DROPBOX_APP_KEY" \
  client_secret "$DROPBOX_APP_SECRET" \
  config_is_local true \
  --obscure \
  --no-output \
  --config "$RCLONE_CONFIG"
```

The Drive backend documents `scope=drive.file` as access to files/folders rclone creates, and the Dropbox backend maps
App key/secret to `client_id`/`client_secret`
([rclone: Drive scope](https://rclone.org/drive/#drive-file),
[rclone: Dropbox credentials](https://rclone.org/dropbox/#get-your-own-dropbox-app-id)). On successful consent, rclone
writes the OAuth token into the selected config. `--obscure` forces rclone to encode the client secret instead of
mistaking a long base64-like value for one that is already obscured, a documented `config create` ambiguity
([rclone: `config create`](https://rclone.org/commands/rclone_config_create/)). `--no-output` suppresses the completed
configuration on stdout, not the browser consent. Do not add `--non-interactive` to this one-shot local command: with
`config_is_local=true`, rclone starts the loopback OAuth flow, while the flag only changes how unanswered configuration
questions are represented. The config must be Packbat's managed `0600` file. The dry run created that mode, and rclone
documents restricted permissions and its need to rewrite refreshed tokens, but Packbat should still enforce the mode
after every create/update ([rclone: config file](https://rclone.org/docs/#config-file)).

### Headless fallback

There are two exact headless forms. The canonical rclone form begins on the headless machine and returns a JSON
continuation containing a base64 configuration blob:

```sh
"$RCLONE" config create packbat-drive drive \
  client_id "$GOOGLE_CLIENT_ID" \
  client_secret "$GOOGLE_CLIENT_SECRET" \
  scope drive.file \
  config_is_local false \
  --obscure \
  --non-interactive \
  --config "$RCLONE_CONFIG"

"$RCLONE" config create packbat-dropbox dropbox \
  client_id "$DROPBOX_APP_KEY" \
  client_secret "$DROPBOX_APP_SECRET" \
  config_is_local false \
  --obscure \
  --non-interactive \
  --config "$RCLONE_CONFIG"
```

Those commands returned `*oauth-authorize,teamdrive,,` for Drive and `*oauth-authorize,,,` for Dropbox in the installed
version. Run the exact emitted `rclone authorize <provider> <base64-json>` command on a browser machine with the same
rclone version, then return its token JSON. Do not decode, log, or put that blob or token into the recovery kit. The
blob preserves Drive's `drive.file` scope
([rclone: remote setup](https://rclone.org/remote_setup/#configuring-using-rclone-authorize),
[rclone: `authorize`](https://rclone.org/commands/rclone_authorize/)). The equivalent explicit browser-machine commands,
also validated with fake IDs and interrupted at the loopback listener, are:

```sh
"$RCLONE" authorize drive "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" \
  --drive-scope drive.file \
  --config "$RCLONE_CONFIG"

"$RCLONE" authorize dropbox "$DROPBOX_APP_KEY" "$DROPBOX_APP_SECRET" \
  --config "$RCLONE_CONFIG"
```

`rclone authorize` accepts a backend plus either the emitted base64 blob or a client-ID/client-secret pair;
`--auth-no-open-browser` prints rather than automatically opening its local link
([rclone: `authorize`](https://rclone.org/commands/rclone_authorize/)). When the wizard receives the returned token JSON,
it can finish without another question:

```sh
"$RCLONE" config create packbat-drive drive \
  client_id "$GOOGLE_CLIENT_ID" \
  client_secret "$GOOGLE_CLIENT_SECRET" \
  scope drive.file \
  token "$OAUTH_TOKEN_JSON" \
  config_refresh_token false \
  config_change_team_drive false \
  --obscure \
  --non-interactive \
  --no-output \
  --config "$RCLONE_CONFIG"

"$RCLONE" config create packbat-dropbox dropbox \
  client_id "$DROPBOX_APP_KEY" \
  client_secret "$DROPBOX_APP_SECRET" \
  token "$OAUTH_TOKEN_JSON" \
  config_refresh_token false \
  --obscure \
  --non-interactive \
  --no-output \
  --config "$RCLONE_CONFIG"
```

Both token-injection dry runs ended with an empty rclone configuration state. In production, pass the token through a
pipe or protected in-memory value rather than a normal environment variable, and unset it immediately afterward.

The wizard must redact the client secret, base64 blob, authorization URL state, returned token JSON, and config contents
from logs. The recovery kit must never include any of them.

## Token lifecycle and doctor behavior

### Google Drive

Google access tokens are short-lived. Offline authorization supplies a refresh token, which the client exchanges at
`https://oauth2.googleapis.com/token` to obtain another access token without user interaction
([Google: offline access](https://developers.google.com/identity/protocols/oauth2/native-app#offline)). A refresh token
can stop working when the user revokes access, after six months without use, when token-count limits evict it, when
time-limited access ends, or because of organization policy. The External/Testing seven-day expiry is an additional case
([Google: refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)). Google limits
one account to 100 live refresh tokens for one client ID; issuing another silently invalidates the oldest token
([Google: refresh-token limits](https://developers.google.com/identity/protocols/oauth2#expiration)).

When a refresh token is expired, invalidated, or revoked, Google's token endpoint returns HTTP 400 with OAuth class
`invalid_grant`. `invalid_client` with HTTP 401 instead points at invalid client authentication
([Google: OAuth error classes](https://developers.google.com/identity/openid-connect/reference#errors),
[Google: desktop refresh failure](https://developers.google.com/identity/protocols/oauth2/native-app#invalid-grant)).
Revoking an access or refresh token removes all OAuth scopes granted to the Cloud project and invalidates tokens for all
clients in that project; propagation can take time
([Google: token revocation](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke)).

Observed refresh behavior and the remaining #36 revocation expectation:

- An expired access token with a valid refresh token is refreshed transparently, `rclone copy` succeeds, and rclone
  updates the token/expiry in the managed config.
- A revoked or expired refresh grant makes `rclone copy` fail while fetching a token. The provider class should be
  `invalid_grant`; #36 captures the exact rclone stderr prefix and exit code after the durability probe.
- `invalid_client` is a different doctor diagnosis: the shipped client credential is invalid, disabled, or deleted,
  not a user grant that merely needs refreshing.

Rclone `v1.74.4` makes the refresh-side class stable enough to classify before the live leg. It retries transient token
fetches up to five times, but treats OAuth HTTP 400/401 responses as fatal. A provider response with
`error=invalid_grant` becomes exactly `couldn't fetch token: invalid_grant: maybe token expired? - try refreshing with
"rclone config reconnect <remote>:"`; `invalid_client`, `unauthorized_client`, `unsupported_grant_type`, and
`invalid_scope` instead receive the client-setup diagnosis. An expired access token with no refresh token becomes a
fatal `token expired and there's no refresh token` error
([rclone: OAuth error wrapping](https://github.com/rclone/rclone/blob/v1.74.4/lib/oauthutil/oauthutil.go#L275-L297),
[rclone: token refresh path](https://github.com/rclone/rclone/blob/v1.74.4/lib/oauthutil/oauthutil.go#L307-L372)).
Packbat currently wraps the entire stderr as `rclone copy failed: ...`; #36 must still capture the provider and
top-level rclone prefixes around this stable inner class.

### Dropbox

Dropbox issues short-lived access tokens. Offline/background access requests `token_access_type=offline`; the code
exchange returns a reusable long-lived refresh token plus an access token, and refresh uses `/oauth2/token` with
`grant_type=refresh_token`
([Dropbox: OAuth guide](https://developers.dropbox.com/oauth-guide),
[Dropbox: offline access](https://dropbox.tech/developers/using-oauth-2-0-with-offline-access)). Refresh tokens do not
expire automatically, but may be revoked. User unlink, team-admin unlink, or `/2/auth/token/revoke` revokes the
authorization; the revoke endpoint also revokes the access token's corresponding refresh token
([Dropbox: offline access](https://dropbox.tech/developers/using-oauth-2-0-with-offline-access)).

Dropbox's API auth taxonomy distinguishes `expired_access_token` from `invalid_access_token`
([Dropbox SDK: auth error tags](https://dropbox.github.io/dropbox-sdk-java/api-docs/v5.4.2/com/dropbox/core/v2/auth/AuthError.Tag.html)).
Its public provider documentation does not guarantee a particular `/oauth2/token` response body for a revoked refresh
token. The live rclone path below supplies the classifier Packbat can rely on.

Observed live behavior:

- An expired access token with a valid refresh token is refreshed transparently, `rclone copy` succeeds, and rclone
  updates the managed config.
- A revoked authorization followed by forced access-token expiry fails at refresh with `invalid_grant` and exit `1`.
- Reauthorization preserves the existing App Folder contents and restores them byte-for-byte.

If Dropbox rejects a still-cached access token before refresh, its API classes remain `expired_access_token` and
`invalid_access_token`. Packbat's deterministic doctor probe should force or await refresh so a revoked grant reaches
the observed `invalid_grant` classifier instead of depending on cached-token timing.

### Live lifecycle observations

The 2026-07-15 live runs resolved the immediate behavior:

- Google Drive: forcing the cached access-token expiry caused rclone to refresh the token, rewrite its future expiry in
  the managed config, and complete `copyto`. The grant remains active for the beyond-seven-days check, so its revoked
  error is not yet known.
- Dropbox: the same forced-expiry probe refreshed successfully. Disconnecting the app in Dropbox while retaining its
  App Folder, then forcing the cached expiry, made `rclone copy` exit `1`. The stable inner error was
  `couldn't fetch token: invalid_grant: maybe token expired? - try refreshing with "rclone config reconnect packbat-dropbox-spike:"`.
  This confirms that `invalid_grant` is a valid Dropbox reauthorization classifier for the rclone path Packbat uses.
  Reconnecting the same remote then restored the original three archives and encrypted index byte-for-byte from the
  retained App Folder, proving that reauthorization neither deletes nor relocates archived data.

### Proposed doctor fact

Doctor should make one cheap, read-only remote probe and classify the structured provider cause where available. It
must not call every 401 an expired grant and must never print token material.

```text
offbox-auth  problem  Google Drive authorization is no longer valid; re-authenticate this destination
offbox-auth  problem  Dropbox authorization is no longer valid; re-authenticate this destination
```

Diagnostic metadata may retain a redacted class such as `invalid_grant`, `invalid_client`, `expired_access_token`, or
`invalid_access_token`. The user-facing remediation is reauthorization for grant failures. Client failures should say
that Packbat's provider client needs repair/update instead.

## Recovery-kit implications

The current [`renderRecoveryKit`](../../apps/cli/src/offbox/recovery-kit.ts) reduces every arbitrary rclone target to
`type: rclone` plus `destination`, then tells a fresh machine to use `--rclone-config default`. That is insufficient for
an OAuth remote backed by Packbat's managed config. Tokens are machine credentials, not recovery material: the new
machine must authorize again, while the kit carries only enough non-secret metadata to reconstruct the destination.

A concrete extension is:

```ts
type RecoveryKitRemote =
  | { type: "oauth"; provider: "google-drive" | "dropbox"; destination: string }
  // existing S3, SFTP, and generic rclone cases
```

and `renderRemote` should produce:

```text
Remote
type: oauth
provider: google-drive
destination: packbat-drive:packbat
authorization: re-authentication required on a new machine
credentials: not included
```

The fresh-machine block should not render today's S3-shaped `packbat init --yes ... --rclone-config default` line.
Until a provider-specific non-interactive init interface exists, it should say:

```text
Fresh-machine setup
Run packbat init, choose Google Drive, and authorize this destination in the browser.
Use destination: packbat-drive:packbat
The recovery kit intentionally contains no access token, refresh token, or OAuth client secret.
```

For Dropbox substitute `Dropbox`. The bundled Packbat client identity comes with Packbat, not the kit. If a future
own-client-ID lane is selected, the kit may record `oauth client: custom` as a non-secret hint, but the user must recover
that client ID/secret from its separate secret store. Never serialize rclone's `token` JSON or the whole managed config.

## Throttle sanity

Packbat runs one sweep per hour. A normal changed sweep copies a handful of new/changed encrypted files, then performs
one `copyto` for the encrypted index. Runs are low-volume, but timer alignment can create a shared-client burst, so both
hourly average and one-minute concurrency matter.

### Google Drive

The ticket's “10 transactions/second per-client shared quota” is present in rclone's guidance, along with a default
100 ms Drive pacer and a recommendation to use a private client ID
([rclone: Drive client ID](https://rclone.org/drive/#making-your-own-client-id),
[rclone: Drive pacer](https://rclone.org/drive/#drive-pacer-min-sleep)). It is not Google's current documented quota for
a new project. On 2026-05-01 Google changed new Drive projects to quota units: 1,000,000 units/minute/project and
325,000 units/minute/user/project. Reads cost 5 units, lists 100, downloads 200, edits 50, and other calls 5. Projects
active between November 2025 and April 2026 retain earlier quotas
([Google: Drive quotas](https://developers.google.com/workspace/drive/api/guides/limits#drive_api_quotas),
[Google: per-method units](https://developers.google.com/workspace/drive/api/guides/limits#per-method_quota_usage)).

The live project exposes a rollout mismatch. `test-project` was created on 2026-07-15, but its Cloud Console quota page
still displays **12,000 queries/minute/project** and **12,000 queries/minute/user**. Google's current Drive API contract
explicitly places projects created on or after 2026-05-01 on the weighted-unit model, so the documented 1,000,000-unit
project limit and 325,000-unit per-user limit remain the design authority. Treat the console rows as legacy or rollout
observability until enforcement proves otherwise; do not combine request counts and quota units in capacity copy.

The complete validation run consumed 46 Drive calls: 13 `DriveFiles.Create`, 12 `DriveFiles.Get`, and 21
`DriveFiles.List`. Four of the Get calls were errors in Cloud metrics, while the byte comparison and refresh probe both
succeeded; no quota or rate-limit error occurred. This all-in run includes upload, download/restore, and the forced
refresh probe, so it is deliberately heavier than one production sweep.

Two isolated cadence probes established the request shape. An unchanged three-file copy used five calls: four List and
one Get. A five-file changed copy used 23: eleven Create, eleven List, and one Get. The single Get in each probe was an
error in Cloud metrics even though both rclone commands exited `0`; neither produced a quota or rate-limit error.

These request traces are not quota-unit totals: the current model weights methods differently and the console does not
expose a per-run unit delta. Packbat's current `:03` timer alignment therefore remains the real risk. Add hour-wide
jitter before a shared client approaches synchronized scale; #36 owns the final unit measurement against the durable
grant rather than extrapolating a capacity promise from request counts.

Quota excess is HTTP 403 `User rate limit exceeded`; backend checks can also return HTTP 429. Google requires truncated
exponential backoff, and quota adjustments can be requested in Cloud Console, although approval is not guaranteed
([Google: quota errors and increases](https://developers.google.com/workspace/drive/api/guides/limits#resolve_time-based_quota_errors)).
The escape hatches are a user-supplied client ID/project that isolates its quota, a project quota adjustment, jittering
the hourly schedule, and rclone's built-in pacing/backoff.

### Dropbox

Dropbox does not publish a numerical request ceiling. It rate-limits per authorization, meaning per linked user for
user links, and returns HTTP 429 `too_many_requests`; clients must honor `Retry-After` because rejected retries also
count. Concurrent writes in one namespace can instead return `too_many_write_operations`
([Dropbox: performance guide](https://developers.dropbox.com/dbx-performance-guide)). Since each Packbat user has a
separate authorization and App Folder, the shared app key is not itself documented as one global request bucket.

Dropbox recommends upload sessions and one batch commit to reduce namespace contention, with at most 1,000 entries per
batch. Rclone's default Dropbox batch mode is synchronous, checks completion, and sizes the batch to `--transfers`; it
discourages disabling batching because doing so can cause long rate-limit waits
([Dropbox: upload/batch guidance](https://developers.dropbox.com/dbx-performance-guide),
[rclone: Dropbox batch mode](https://rclone.org/dropbox/#batch-mode-uploads)). An hourly handful plus one index is well
below the batch-size boundary, but no defensible user-count ceiling exists without Dropbox publishing a limit or the
live cadence test observing one. Escape hatches are per-user authorization isolation, normal rclone batching/backoff,
and, if Dropbox identifies an app-level constraint during production review, a provider-approved limit increase or an
own-app-key lane.

Dropbox's practical pre-review adoption ceiling is 49 linked users. User 50 begins the two-week production-approval
deadline, despite the nominal 500-user development maximum. That is an approval ceiling, not a throughput ceiling.

## Production-readiness follow-ups

1. [#36](https://github.com/liamvinberg/packbat/issues/36) owns the calendar-bound Google proof: reuse this exact grant
   after seven days, record weighted-unit deltas for unchanged and changed sweeps, then revoke, classify, reauthorize,
   and prove retained data.
2. [#37](https://github.com/liamvinberg/packbat/issues/37) owns Dropbox production authorization: obtain acceptance of
   rclone's current public-client shape or use a PKCE-capable flow before the approval threshold.

## Spike completion checklist

Issue #16 established the provider decision and handed the remaining release gates to their own tracked work:

1. [x] Register both throwaway applications from the runbooks and record labels that differ from the research.
2. [x] Run both local browser-consent flows and verify the managed config is mode `0600` without recording credentials.
3. [x] Confirm Google requests only `drive.file` and Dropbox is confined to the App Folder with the listed scopes.
4. [x] Copy a synthetic tree, overwrite the encrypted index with `copyto`, restore separately, and compare bytes.
5. [x] Force access-token refresh for each provider and prove the transfer succeeds and the expiry changes.
6. [x] Revoke Dropbox and record exact stderr, exit code, and provider class: `invalid_grant`, exit `1`.
7. [x] Reauthorize Dropbox, repeat restore, and prove no remote data was lost or moved.
8. [x] Capture the live Google method traces, including five calls for an unchanged sweep and 23 for a five-file
   changed sweep, and reconcile the apparent quota model mismatch against the current API contract. Exact weighted-unit
   deltas remain the release task in #36.
9. [ ] #36: confirm the In-production Google refresh token remains usable beyond seven days, then revoke and
   reauthorize. Complete brand verification before public onboarding.
10. [ ] #37: settle Dropbox PKCE/production acceptance and apply before linked user 50 starts the two-week deadline.
