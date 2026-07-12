# blotter

CLI that preserves AI-agent sessions (Claude Code, Codex, any harness) as raw, append-only archives in a store the user owns. Free and open source.

Product invariants (locked at inception, 2026-07):

- **Raw at rest, transformation on read.** Archives are verbatim session files, compressed. Never normalize, never redact at rest — a restored file must resume in its harness.
- **Append-only.** Nothing in the archive is ever mutated or deleted; re-archiving only happens when the source is newer.
- **Local-first, own-your-store.** Off-box copies are encrypted before leaving the machine with a key only the user holds. No hosted service, no account, no telemetry.
- **Turnkey.** One wizard, then zero required interaction. `doctor` proves nothing is being missed.

## Layout

pnpm workspace monorepo: `apps/cli` (the tool), `apps/web` (site + docs), `packages/*` (shared). Node 22+, TypeScript, maximal strictness (`tsconfig.base.json`), Biome.

## Conventions

- kebab-case filenames; no barrel exports; thin entry points.
- Commits: atomic, lowercase, terse, no body (`feat: …`, `fix: …`, `polish: …`).
- Vitest, colocated `*.test.ts`, prefer real integrations over mocks.
- Hard-cut policy: one canonical current-state path, no compatibility bridges or fallback paths unless explicitly requested.

## Agent skills

### Issue tracker

GitHub Issues on this repo; external PRs are not a triage surface. Planning runs wayfinder-style (map + sub-issue tickets, native dependencies). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
