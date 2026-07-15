# Packbat agent guide

CLI that preserves AI-agent sessions (Claude Code, Codex, any harness) as raw, append-only
archives in a store the user owns. Spec: issue #14. Canonical constraints: `docs/research/`.

## Product invariants (locked — every decision defers to these)

- **Raw at rest, transformation on read.** Archives are verbatim session files, compressed.
  Never normalize, never redact at rest — a restored file must resume in its harness.
- **Append-only.** Nothing in the archive is ever mutated or deleted; re-archiving only
  happens when the source is newer.
- **Local-first, no required account.** User-owned storage remains the default off-box lane.
  Every off-box copy is encrypted before leaving the machine with a key only the user holds.
  Optional Packbat Cloud stores ciphertext only and decrypts client-side; the key never
  reaches Packbat, plaintext hosting and key escrow are permanently out of scope, and there
  is no telemetry (ADR 0001).
- **Turnkey.** One wizard, then zero required interaction. `doctor` proves nothing is missed.

## Layout

pnpm workspace: `apps/cli` (the tool) and `apps/cloud` (the optional Cloud Worker control plane). Node ≥ 22.15,
TypeScript maximal strictness (`tsconfig.base.json`), Biome (tabs, width 120), tsup/Workerd builds, tsx dev, Vitest.

## Conventions

- kebab-case filenames; no barrel exports; no default exports except tool/runtime entry points that require one;
  thin entry points and thin `commands/*` over `core/*`.
- Commits: atomic, lowercase, terse, no body (`feat: …`, `fix: …`, `polish: …`).
- Vitest. CLI pure logic gets colocated `*.test.ts`; everything else tests at the CLI process boundary
  (`apps/cli/test/helpers/run-cli.ts`) against temp roots. Real zstd, real age, real filesystem, no mocks. CLI tests
  assert only exit codes, output, and files on disk; no test reaches into module internals.
- Cloud service tests run at the Worker HTTP boundary against real Workerd, D1 migrations, and Web Crypto. A
  provider fake is allowed only at the outbound third-party HTTP boundary. Direct D1 assertions are reserved for
  durable-state minimization, tenant isolation, quota/accounting atomicity, and deletion invariants.
- Fixture stores are synthetic (`docs/research/harness-session-stores.md` fidelity);
  no real session content in fixtures, ever.
- Hard-cut policy: one canonical current-state path, no compatibility bridges or fallback
  paths unless explicitly requested.
- No new dependencies without flagging it loudly.

## Agent workflows

### Issue tracker

GitHub Issues on this repo; external PRs are not a triage surface. Planning runs wayfinder-style
(map + sub-issue tickets, native dependencies). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, created lazily. See
`docs/agents/domain.md`.

## Gates

```
pnpm -C apps/cli typecheck && pnpm -C apps/cli test && pnpm -C apps/web typecheck && pnpm -C apps/web build && pnpm check
```
