# ADR 0005: Packbat Cloud lanes are disabled by default

Status: accepted 2026-07-23 (Liam's call).

## Context

ADR 0001 made Packbat Cloud a GO as an E2E-only lane and ADR 0002 made it paid-only. The lanes
were built pre-GA: `packbat cloud link|unlink|billing`, a wizard destination entry, and the
Worker control plane in `apps/cloud`. The public site never advertised Cloud, and every Cloud
capability that matters to the product promise (autosync, mirror, multi-machine convergence,
restore) also works against user-owned remotes through rclone.

Liam decided not to offer Cloud for now. The direction is user-owned storage as the only
offered lane, with the Cloud code kept rather than removed.

## Decision

Packbat Cloud entry points are disabled by default:

- The wizard no longer offers Packbat Cloud as an off-box destination.
- `packbat cloud <verb>` refuses with a plain message unless `PACKBAT_CLOUD=1` is set in the
  environment. That variable is the development arm, mirroring `PACKBAT_CLOUD_API_URL` and
  `PACKBAT_REGISTRY_URL`.

Everything else stays. The `cloud` remote type remains in the config schema, and a machine that
already carries a linked Cloud remote keeps syncing, mirroring, and reporting doctor facts; the
gate blocks new linking, not existing custody. `apps/cloud` and its tests remain in the repo and
in the gates. The deployed Worker is an operational concern outside this ADR.

ADR 0001 and ADR 0002 stay the record of what Cloud is whenever it is offered: ciphertext only,
key never reaches Packbat, paid-only. This ADR changes availability, not architecture.

## Consequences

- The wizard's storage step offers exactly the user-owned lanes: Google Drive, Dropbox, S3,
  own server, or skip.
- Re-enabling Cloud is one gate flip plus restoring the wizard entry; no rebuild of the lanes.
- Cloud boundary tests run with `PACKBAT_CLOUD=1` and a refusal test pins the default.
- The public site keeps its factual Cloud mentions (privacy policy, checkout return routes);
  they describe an optional lane that is currently not offered.
