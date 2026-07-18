# OAuth destinations

Research date: 2026-07-14. Live validation: 2026-07-15 and 2026-07-16. Production registration ride-along:
2026-07-18. Dropbox authorization ruling: 2026-07-16. Console labels and provider policy are current as of those
dates. Credential and token material is deliberately excluded from this artifact.

## Recommendation

| Provider | Verdict | Why | Release boundary |
| --- | --- | --- | --- |
| Google Drive | **Go for the wizard** | The live Desktop client requested only `drive.file`; an In-production grant completed publish, byte-identical restore, forced refresh, revocation classification, reauthorization, and retained-data restore through Packbat's managed rclone config. | Integrate the proven flow into the destination wizard and publish verified branding before public onboarding. |
| Dropbox | **Go for the wizard; production approval remains** | Packbat's no-secret S256 PKCE client completed the full App Folder lifecycle, including rclone refresh, revocation, reauthorization, and retained-data restore. | Integrate the proven client into the destination wizard, then apply for production approval before the linked-user deadline. Never ship stock rclone's secret-based authorization flow. |

Both provider backends passed their lifecycle proofs, but neither public wizard lane is integrated yet. Google's
remaining public-onboarding work is branding and wizard integration. Dropbox's remaining release work is wizard
integration and the normal production application.

## Live validation status

Live validation began on 2026-07-15 against Google Cloud project `test-project` and Dropbox app
`packbat-oauth-spike-liam`. Credential material stayed outside the repository under `~/.packbat/oauth-spike/` in
mode-`0600` files during the proof and was removed afterward. The managed scratch rclone config was also mode `0600`
and was removed after validation; no token, client secret, or authorization URL is recorded in this document.

| Provider | Current verdict | Live evidence | Remaining gate |
| --- | --- | --- | --- |
| Google Drive | **Lifecycle proof passed** | External app published **In production**; Desktop client; only `drive.file`; consent matched that scope; synthetic archives and index round-tripped byte-for-byte; forced access-token expiry refreshed; Google Account revocation produced `invalid_grant` and exit `1`; reauthorization restored the retained bytes. | Integrate the proven flow in the wizard. Brand verification remains a public-onboarding gate. |
| Dropbox | **No-secret PKCE flow passed** | App Folder app; documented minimum scopes; registered loopback redirect; S256 PKCE with offline access and no app secret; three synthetic archives plus one index round-tripped byte-for-byte; forced expiry refreshed through rclone; provider revocation produced `invalid_grant` and exit `1`; reauthorization restored the retained bytes. | Consume the proven client in the wizard, then complete the normal production application. |

The 2026-07-15 live scripts ran as `packbat-drive-spike` and `packbat-dropbox-spike`. The 2026-07-16 Google follow-up
reused the Drive remote, revoked it through Google Account, reauthorized it, and restored the retained bytes. The
2026-07-16 Dropbox run used Packbat's shipped authorization seam and a `packbat-dropbox-pkce-proof` rclone remote; its
redacted evidence is recorded below.

The planned seven-day Google wait was removed from the release gate. Google's contract applies that expiry only to
External apps in **Testing**; the tested app was already **In production**. A second live refresh after seven days would
repeat the provider contract without exercising a distinct Packbat behavior, while delaying revocation and recovery
evidence that can be collected immediately
([Google: app audience](https://support.google.com/cloud/answer/15549945#publishing-status),
[Google: refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).

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
   [Google: manage OAuth clients](https://support.google.com/cloud/answer/15549257)). The current creation dialog shows
   the client ID but not the client secret. Open the new client's detail page and expand **Additional information >
   Client secrets** to retrieve the secret. Save both values in the project's secret-management system, never in this
   repository. Google treats installed apps as public clients that cannot keep a client secret confidential
   ([Google: installed-app overview](https://developers.google.com/identity/protocols/oauth2/native-app#overview)).
6. Run the rclone local-webserver flow in the live-leg script. A Desktop client is the correct client type for a system
   browser plus loopback listener; Google recommends the loopback-IP redirect for macOS, Linux, and Windows desktop apps
   ([Google: loopback redirect](https://developers.google.com/identity/protocols/oauth2/native-app#redirect-uri_loopback)).
7. After the test consent and copy/restore pass, open **Audience** and click **Publish app** to change publishing status
   to **In production**. Do not ship with Testing status: authorization by a test user expires seven days after consent,
   including an offline refresh token, because `drive.file` is outside the profile-only exception. In-production apps
   are available to any Google Account and are not subject to that Testing-only seven-day expiry
   ([Google: app audience](https://support.google.com/cloud/answer/15549945#publishing-status)).

### Production registration ride-along, 2026-07-18

The shared release registration used a new project named **Packbat** and the generated project ID `packbat`. The
current console begins with **Google Auth Platform not configured yet > Get started**, then presents four project
configuration steps:

1. **App Information**: app name **Packbat** and the user-support email.
2. **Audience**: **External**.
3. **Contact Information**: the developer-contact email.
4. **Finish**: accept the Google API Services User Data Policy and create the configuration.

The current left navigation is **Branding**, **Audience**, **Clients**, and **Data Access**. On **Branding**, the shared
registration used `https://packbat.dev` as the homepage and `packbat.dev` as the authorized domain. The console reported
that verification was not required while the app remained in Testing. On **Data Access > Add or Remove Scopes**, add
only `https://www.googleapis.com/auth/drive.file`; if the scope is not offered, enable **Google Drive API** in the API
Library first and return to Data Access. The shared client was created under **Clients > Create Client** as application
type **Desktop app**, name **Packbat CLI**. The success dialog exposed only the client ID; the client detail page exposed
the client secret under **Additional information > Client secrets**. No credential value is recorded here.

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
4. Still on **Settings**, record the **App key** as Packbat's public client identifier. Packbat does not need or
   distribute the **App secret**. Dropbox API support confirmed that an app unable to secure its secret must use PKCE
   without the secret
   ([Dropbox support answer](https://github.com/liamvinberg/packbat/issues/37#issuecomment-4990175044)).
5. The new app begins in development status and initially links only its owner's account. Use **Enable additional
   users** when the live spike is ready to test another account. A development app can link at most 500 users. At 50
   linked users a two-week window starts in which the app must apply for and receive production approval; otherwise new
   links freeze, and unlinking users does not unfreeze them. Dropbox normally reviews at 50 users, although an earlier
   submission can be considered with compelling evidence. Approved production apps have no linked-user cap
   ([Dropbox: development and production status](https://www.dropbox.com/developers/reference/developer-guide)).

The ticket's phrase “development mode covers early adopters” is correct, but “production review opens at 50” is
incomplete. The actionable boundary is a deadline triggered at user 50, not a 50-user development cap.

### Production registration ride-along, 2026-07-18

The shared release app used the current **Create app** sequence: **Scoped access**, **App folder**, app name **Packbat**,
then **Create app**. On **Settings**, register `http://localhost:53682/` under **OAuth 2 > Redirect URIs**; the console
confirms with **OAuth URI added**. On **Permissions**, select `account_info.read`, `files.metadata.read`,
`files.metadata.write`, `files.content.read`, `files.content.write`, `sharing.read`, and `sharing.write`, then click
**Submit**. The App key is the only release credential; do not generate, store, or ship an App secret.

**Apply for production** first refused to open until the app had an icon. The current **Branding** form contains **App
name**, **Publisher**, **Description**, **App website**, **Privacy policy URL**, and Dropbox Chooser controls for 64x64
and 256x256 icons. The shared app uses publisher **Packbat**, the existing site description, `https://packbat.dev`, and
the Packbat mark as its 256x256 source. The chooser requires first uploading the image into the signed-in Dropbox
account, then selecting it. The console persists the 256x256 source and leaves the 64x64 slot as its generated/default
preview.

After branding is saved, **Settings > Apply for production** opens **Request production status**. The current form
requires all of the following before submission:

1. Confirm **My app will need to link with more than 50 Dropbox users**.
2. Complete **How does your app use the Dropbox API?**. **What does your app do?** and **What is your app's website?**
   are prefilled from Branding.
3. Supply a live **What is your app's privacy policy link?** URL.
4. Choose one or more platforms from **Android**, **iOS**, **OS X**, **Web**, **Windows**, and **Other**.
5. Complete **How can we try your app's Dropbox integration?** with detailed step-by-step testing instructions.
6. Either provide third-party test credentials or confirm **My app doesn't require the user to have a non-Dropbox
   account to use the app**.
7. Confirm at least one testing condition: the app is freely downloadable by an external party, or the application
   includes test credentials, a test build, screenshots, or a screencast.

**Request early review** is optional and explicitly reserved for a compelling reason to review before 50 linked users.
As of the ride-along, `packbat.dev` has no privacy-policy route, so the application was left unsubmitted rather than
using a placeholder or broken URL.

### Release credential wiring

The release repository stores only these three Actions secret names:

- `PACKBAT_GOOGLE_DRIVE_CLIENT_ID`
- `PACKBAT_GOOGLE_DRIVE_CLIENT_SECRET`
- `PACKBAT_DROPBOX_APP_KEY`

Credential values travel directly from the provider console clipboard into `gh secret set`; they must not enter shell
arguments, files, logs, screenshots transcriptions, or this document. A full rerun of publish run `29622207524` on
2026-07-18 reran Release Please after `v0.2.1` already existed. Release Please therefore returned no newly created
release and GitHub skipped the `publish` job. npm remained on `0.1.0`. Recovery must rerun the original failed publish
leg while retaining its original `release_created` output, or use an explicitly reviewed workflow recovery; do not
delete or recreate the release, weaken the release guard, or bump the version to escape the condition.

### Public-client and PKCE ruling

Dropbox recommends PKCE whenever an application cannot keep its client secret secure and explicitly includes desktop
and open-source applications in that category. Rclone `v1.74.4` does not implement PKCE in its shared OAuth utility:
its Dropbox backend supplies a client ID and client secret, constructs an ordinary authorization-code request, and
exchanges the returned code without a `code_verifier`. Rclone's current official custom-app runbook nevertheless tells
users to register and distribute exactly an App key and App secret, and the live Packbat app completed that flow.
([Dropbox: PKCE guidance](https://developers.dropbox.com/oauth-guide#implementing-pkce),
[rclone: Dropbox app credentials](https://rclone.org/dropbox/#get-your-own-dropbox-app-id),
[rclone: OAuth exchange](https://github.com/rclone/rclone/blob/v1.74.4/lib/oauthutil/oauthutil.go#L908-L919)).

Dropbox API support answered Packbat's exact question on 2026-07-16. It would not pre-approve the app's overall
compliance from a description, but it did settle this authorization point: apps must not publicly distribute their app
secret, and a client that cannot secure the secret must use PKCE without it
([Dropbox support answer](https://github.com/liamvinberg/packbat/issues/37#issuecomment-4990175044)). This turns the
documentation's earlier recommendation into a release requirement.

The production flow must use S256 PKCE and offline access. The authorization request carries the public App key,
`state`, `redirect_uri`, `token_access_type=offline`, `code_challenge`, and `code_challenge_method=S256`. The code
exchange carries the App key and in-memory `code_verifier`, not `client_secret`. Packbat stores the returned refresh
token only in its mode-`0600` managed rclone config. Stock rclone `v1.74.4` cannot perform that exchange, so its direct
Dropbox authorization commands are disqualified for the public wizard.

Packbat owns the Dropbox PKCE browser and token exchange, then injects the token into stock rclone. Rclone remains the
data plane and token refresher. Waiting for an unplanned upstream rclone change is not a release path, and Packbat will
not carry both authorization paths. The 2026-07-16 live proof closed this gate without an app secret.

### Shipped PKCE and rclone handoff

[`authorizeDropboxRemote`](../../apps/cli/src/offbox/dropbox-oauth.ts) owns the complete authorization boundary:

1. Generate a 64-byte random verifier, base64url-encode it to 86 RFC 7636 characters, derive the S256 challenge, and
   generate a separate 32-byte random `state`. The verifier and state exist only in process memory.
2. Bind a loopback-only listener to the registered redirect before opening the system browser. Request
   `response_type=code`, `token_access_type=offline`, the public App key, the redirect, `state`, the challenge, and
   `code_challenge_method=S256`. A callback with the wrong state receives HTTP 400 and cannot complete the flow.
3. Exchange the accepted code using `grant_type=authorization_code`, the public App key, the same redirect, and the
   in-memory `code_verifier`. The request has no `client_secret`. Provider response bodies are never included in an
   error.
4. Convert the successful Dropbox response into rclone's refreshable token shape in memory. Pass that object directly
   to [`renderDropboxRemote`](../../apps/cli/src/offbox/rclone-conf.ts), then atomically write the managed config at
   mode `0600`.

The handoff does not invoke `rclone config`, put token JSON in an argument or environment variable, or maintain a
second authorization path. Rclone first sees the grant when it reads Packbat's managed config for a data-plane command:

```ini
[packbat]
type = dropbox
client_id = <public App key>
token = <in-memory token JSON serialized directly to this mode-0600 file>
```

There is deliberately no `client_secret`. Authorization URLs, state, verifier, code, token JSON, and refresh tokens
never enter Packbat output, errors, fixtures, or the recovery kit. The process-boundary test drives the real loopback
listener and HTTP exchange against a local provider, rejects a mismatched state, verifies the challenge from the
received verifier, and asserts only the private config file plus redacted process output.

Redacted live evidence from 2026-07-16, against `packbat-oauth-spike-liam` with rclone `v1.74.4`:

- S256 PKCE authorization received only the public App key, requested offline access, and never sent or wrote an app
  secret.
- Packbat wrote the managed rclone config at mode `0600`; its Dropbox section contained the public App key and token,
  with no `client_secret` field.
- Three synthetic ciphertext-shaped archives plus one encrypted-index-shaped file published and restored
  byte-for-byte.
- A forced cached-access expiry made rclone refresh the PKCE grant and rewrite a future expiry while retaining the
  refresh token.
- Dropbox's revoke endpoint invalidated the grant. After another forced expiry, rclone failed refresh with
  `invalid_grant` and exit `1`.
- A fresh Packbat PKCE authorization restored the original retained remote bytes without moving or deleting them.

The proof completed at `2026-07-16T09:59:23.507Z`; its remote root was
`packbat-dropbox-pkce-proof:packbat-pkce-proof/20260716T095705Z`. No credential or token material was recorded.

## Rclone invocations for the wizard

Rclone accepts backend options as `key value` or `key=value` pairs on `config create`. When questions remain and
`--non-interactive` is absent, it takes their defaults; `--non-interactive` instead exposes a JSON state machine for an
embedding application
([rclone: `config create`](https://rclone.org/commands/rclone_config_create/)). The wizard's simplest lane is therefore
a command with every material backend option supplied, followed only by the unavoidable system-browser consent.

The Google commands below remain candidate wizard invocations. The Dropbox commands containing `client_secret` record
the 2026-07-15 spike only. Dropbox rejected that shape for a public client, so those commands must not ship.

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

# Dropbox spike only. Rejected for the public wizard because it distributes the
# app secret and does not use PKCE.
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

# Dropbox spike only. Rejected for the public wizard.
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

# Dropbox spike only. Rejected for the public wizard.
"$RCLONE" authorize dropbox "$DROPBOX_APP_KEY" "$DROPBOX_APP_SECRET" \
  --config "$RCLONE_CONFIG"
```

`rclone authorize` accepts a backend plus either the emitted base64 blob or a client-ID/client-secret pair;
`--auth-no-open-browser` prints rather than automatically opening its local link
([rclone: `authorize`](https://rclone.org/commands/rclone_authorize/)). The Drive wizard can finish from its returned
token without another question:

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
```

Dropbox does not use this command path. Packbat's S256 PKCE exchange passes its token object directly to the managed
config renderer described above, so the token never appears in a process argument, pipe, or environment variable.

The wizard must redact any Google client secret, base64 blob, authorization URL state, returned token JSON, and config
contents from logs. A Dropbox app secret must never enter the shipped flow. The recovery kit must never include any of
these values.

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

Observed Google lifecycle behavior:

- An expired access token with a valid refresh token is refreshed transparently, `rclone copy` succeeds, and rclone
  updates the token/expiry in the managed config.
- Revoking the grant through Google Account and then forcing the cached access-token expiry made rclone fail while
  creating the Drive filesystem. The stable inner class was `couldn't fetch token: invalid_grant: maybe token expired?`
  and rclone exited `1`.
- `rclone config reconnect` created a new `drive.file` grant against the same remote. Downloading the pre-revocation
  remote root restored all three synthetic archives and the encrypted index byte-for-byte, proving revocation and
  reauthorization do not delete or relocate retained Drive data.
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
Packbat currently wraps the entire stderr as `rclone copy failed: ...`; the live proof confirms that the inner
`invalid_grant` class is available for the doctor classifier.

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

The 2026-07-15 and 2026-07-16 live runs resolved the immediate behavior:

- Google Drive: forcing the cached access-token expiry caused rclone to refresh the token, rewrite its future expiry in
  the managed config, and complete `copyto`. Revoking the grant through Google Account, forcing expiry again, and
  retrying a copy produced `invalid_grant` and exit `1`. Reauthorization of the same remote restored the retained
  archives and encrypted index byte-for-byte.
- Dropbox: both the rejected secret-based spike and the shipped no-secret PKCE path refreshed successfully after a
  forced expiry. Revoking each authorization while retaining its App Folder, then forcing another expiry, made rclone
  exit `1` with `invalid_grant`. A fresh Packbat PKCE authorization restored the original three archives and encrypted
  index byte-for-byte from the retained App Folder, proving that reauthorization neither deletes nor relocates
  archived data.

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

Applying Google's current method weights to those isolated traces gives the production-sweep cost. The unchanged sweep
used `4 × 100` List units plus `1 × 5` Get units, for **405 quota units**. The five-file changed sweep used
`11 × 50` Create/edit units, `11 × 100` List units, and `1 × 5` Get units, for **1,655 quota units**. The Cloud Console
does not expose a per-run weighted-unit delta, so the method trace is the auditable measurement. Its legacy 12,000-query
rows remain request-count observability and must not be mixed with the weighted totals.

Packbat's current `:03` timer alignment remains the real risk. Add hour-wide jitter before a shared client approaches
synchronized scale rather than extrapolating a capacity promise from hourly averages.

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

1. [#36](https://github.com/liamvinberg/packbat/issues/36) resolved the Google lifecycle proof: the In-production
   contract removes Testing's seven-day expiry, the live grant classified revocation, reauthorized, restored retained
   data, and established weighted-unit costs for unchanged and changed sweeps.
2. [#37](https://github.com/liamvinberg/packbat/issues/37) resolved the Dropbox production authorization decision:
   Dropbox requires S256 PKCE without an app secret for Packbat's public client.
3. [#38](https://github.com/liamvinberg/packbat/issues/38) resolved the implementation and live proof: the
   Packbat-owned PKCE exchange injects its token into rclone and passed the full lifecycle.
4. [#17](https://github.com/liamvinberg/packbat/issues/17) integrates the proven flow into the destination wizard,
   then applies for production approval before the approval threshold.

## Spike completion checklist

Issue #16 established the provider decision and handed the remaining release gates to their own tracked work:

1. [x] Register both throwaway applications from the runbooks and record labels that differ from the research.
2. [x] Run both local browser-consent flows and verify the managed config is mode `0600` without recording credentials.
3. [x] Confirm Google requests only `drive.file` and Dropbox is confined to the App Folder with the listed scopes.
4. [x] Copy a synthetic tree, overwrite the encrypted index with `copyto`, restore separately, and compare bytes.
5. [x] Force access-token refresh for each provider and prove the transfer succeeds and the expiry changes.
6. [x] Revoke Dropbox and record exact stderr, exit code, and provider class: `invalid_grant`, exit `1`.
7. [x] Reauthorize Dropbox, repeat restore, and prove no remote data was lost or moved.
8. [x] Capture the live Google method traces, including five calls and 405 units for an unchanged sweep and 23 calls
   and 1,655 units for a five-file changed sweep, then reconcile the apparent Console quota-model mismatch against the
   current API contract.
9. [x] #36: verify the In-production token contract, revoke and classify the live grant, reauthorize, restore retained
   bytes, and calculate weighted-unit costs. Complete brand verification before public onboarding.
10. [x] #37: obtain Dropbox's written ruling. Public clients must use PKCE without an app secret.
11. [x] #38: ship and live-validate Dropbox S256 PKCE without an app secret.
12. [ ] #17: integrate the proven flow and apply before linked user 50 starts the two-week deadline.
