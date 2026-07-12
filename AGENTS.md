# blotter — agent guide

CLI that preserves AI-agent sessions (Claude Code, Codex, any harness) as raw, append-only
archives in a store the user owns. Spec: issue #14. Canonical constraints: `docs/research/`.

## Product invariants (locked — every decision defers to these)

- **Raw at rest, transformation on read.** Archives are verbatim session files, compressed.
  Never normalize, never redact at rest — a restored file must resume in its harness.
- **Append-only.** Nothing in the archive is ever mutated or deleted; re-archiving only
  happens when the source is newer.
- **Local-first, own-your-store.** Off-box copies are encrypted before leaving the machine
  with a key only the user holds. No hosted service, no account, no telemetry.
- **Turnkey.** One wizard, then zero required interaction. `doctor` proves nothing is missed.

## Layout

pnpm workspace: `apps/cli` (the tool). Node ≥ 22.15, TypeScript maximal strictness
(`tsconfig.base.json`), Biome (tabs, width 120), tsup build, tsx dev, Vitest.

## Conventions

- kebab-case filenames; no barrel exports; no default exports; thin entry points and
  thin `commands/*` over `core/*`.
- Commits: atomic, lowercase, terse, no body (`feat: …`, `fix: …`, `polish: …`).
- Vitest, colocated `*.test.ts` for pure logic only; everything else tests at the CLI
  process boundary (`apps/cli/test/helpers/run-cli.ts`) against temp roots. Real zstd,
  real age, real filesystem — no mocks. Tests assert only externally observable behavior:
  exit codes, output, files on disk. No test reaches into module internals.
- Fixture stores are synthetic (`docs/research/harness-session-stores.md` fidelity);
  no real session content in fixtures, ever.
- Hard-cut policy: one canonical current-state path, no compatibility bridges or fallback
  paths unless explicitly requested.
- No new dependencies without flagging it loudly.

## Gates

```
pnpm -C apps/cli typecheck && pnpm -C apps/cli test && pnpm check
```
