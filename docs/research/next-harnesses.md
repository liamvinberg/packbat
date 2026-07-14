# OpenCode and Gemini CLI store semantics

Research date: 2026-07-14 (Europe/Stockholm).

This report settles GitHub issue #22 against released source, not `main` or `dev`. OpenCode findings are pinned to
`v1.17.5` (`8d78715d64d6f2401e5dfcd93745d082aaa1d163`), the version installed on the research machine. The storage
transition is cross-checked against `v1.1.65` (`34ebe814ddd130a787455dda089facb23538ca20`) and `v1.2.0`
(`ffc000de8e446c63d41a2e352d119d9ff43530d0`). Gemini findings are pinned to `v0.50.0`
(`8d9733d531c70284d77b09e1ff5e61dde2d61ebc`). Source clones live under
`.scratch/wayfinder-v2/next-harnesses/`. Gemini CLI was not installed, so its findings are source-only.

## Verdict

| Harness | Current store | `mutationModel` | Adapter unit |
| --- | --- | --- | --- |
| OpenCode | One WAL-mode SQLite database | `db-snapshot` | A consistent database snapshot, not an individual session |
| Gemini CLI | Project-scoped JSONL chat files, plus legacy JSON | `append-file` | One top-level chat file plus its session-owned sidecars |

OpenCode makes `db-snapshot` necessary. Gemini does not.

## OpenCode

### The JSON-tree documentation is historical

The apparent conflict is versioned, not platform-dependent:

- `v1.1.65` stored mutable JSON under `$XDG_DATA_HOME/opencode/storage/`. The storage layer resolved keys to
  `<key...>.json`, rewrote files for updates, and listed the tree recursively
  ([source](https://github.com/anomalyco/opencode/blob/34ebe814ddd130a787455dda089facb23538ca20/packages/opencode/src/storage/storage.ts#L144-L226)).
  Its session layout was `session/<project-id>/<session-id>.json`, `message/<session-id>/<message-id>.json`,
  `part/<message-id>/<part-id>.json`, and `session_diff/<session-id>.json`; the older per-project layout was copied
  into that shape by the same file-store migrations
  ([source](https://github.com/anomalyco/opencode/blob/34ebe814ddd130a787455dda089facb23538ca20/packages/opencode/src/storage/storage.ts#L24-L141)).
- `v1.2.0`, released 2026-02-14, reverted OpenCode to SQLite. Its release notes explicitly say that first run
  migrates all flat files into one database and leaves the original data in place
  ([release](https://github.com/anomalyco/opencode/releases/tag/v1.2.0)). The migration scans projects, sessions,
  messages, parts, todos, permissions, and shares, then inserts them in one transaction
  ([source](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/storage/json-migration.ts#L24-L152),
  [source](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/storage/json-migration.ts#L188-L319),
  [source](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/storage/json-migration.ts#L321-L435)).
  Database absence is the one-time migration trigger
  ([source](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/index.ts#L82-L117)).
- OpenCode removed the JSON migrator and its startup bootstrap in PR
  [#30461](https://github.com/anomalyco/opencode/pull/30461), merged 2026-06-02; `v1.16.0` is the first subsequent
  release. `v1.17.5` is therefore a hard-cut SQLite release. The legacy `storage/` directory may remain after an
  older upgrade, but it is not the live session store. A current adapter must not enumerate it or provide a JSON
  fallback; that would violate Packbat's hard-cut policy and could archive stale data.

### Store root and overrides

The default data directory is `${XDG_DATA_HOME:-~/.local/share}/opencode`; OpenCode derives it through
`xdg-basedir` ([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/global.ts#L1-L31)).
For stable channels the database is `<data-dir>/opencode.db`. `OPENCODE_DB` overrides the database: an absolute
value is used verbatim, while a relative value is resolved under the data directory. Non-stable installation
channels can use `opencode-<channel>.db`
([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/database/database.ts#L39-L61)).

Adapter resolution should therefore return a database descriptor rather than pretend the data directory itself is
one file store:

```text
dataRoot = ${XDG_DATA_HOME:-~/.local/share}/opencode
database = OPENCODE_DB absolute
        or dataRoot/OPENCODE_DB when OPENCODE_DB is relative
        or dataRoot/opencode.db for the stable channel
```

`registry.ts` currently gets the stable default and absolute `OPENCODE_DB` case right, but it treats every relative
`OPENCODE_DB` as relative to the process cwd. The adapter plan must resolve that case under `dataRoot`.

### Read-only local observation

`/opt/homebrew/bin/opencode --version` reported `1.17.5`. Read-only inspection found the expected
`~/.local/share/opencode/opencode.db`: 659,456 bytes, `PRAGMA journal_mode` returned `wal`, and the schema integrity
check returned `ok`. At the observation point `opencode.db-wal` existed at 0 bytes and `opencode.db-shm` at 32,768
bytes. The database held 2 session rows, 10 message rows, and 33 part rows; the session rows reported OpenCode
version `1.17.4`. No authentication file, API key, message content, or part content was read.

### What a resumable session consists of

The minimum resume payload is one transactionally consistent copy of the whole database. Session state is
normalized, so no independently copyable file corresponds to one session:

- `session` is the identity and metadata row. It includes project/workspace/parent links, the original absolute
  directory, title, version, share URL, embedded summary diffs, counters, revert state, permissions, model/agent,
  and archive timestamps. `project` is a required foreign-key parent; `workspace` can also be part of instance
  identity ([schema](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/session/sql.ts#L21-L65)).
- Legacy/current UI transcript projections are rows in `message` and `part`; parts carry the text, reasoning, tool
  state, snapshots, patches, and attachments used to reconstruct each message
  ([schema](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/session/sql.ts#L67-L97)). The reader selects messages by
  `session_id` and hydrates their parts
  ([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/session/message-v2.ts#L436-L529)).
- The current event-sourced path additionally uses `session_message`, `session_input`, and
  `session_context_epoch`; its resume history loads messages after the latest compaction and applies the context
  epoch baseline
  ([schema](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/session/sql.ts#L118-L175),
  [source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/session/history.ts#L13-L99)). Durable source events and
  their sequence counters live in `event` and `event_sequence`
  ([schema](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/event/sql.ts#L4-L25)).
- `todo` and `session_share` are session-linked state. They are not required to recover conversation context, but a
  raw whole-database snapshot naturally preserves them and avoids inventing a lossy per-session boundary.

There are two data-root sidecar classes outside SQLite:

- `snapshot/<project-id>/<worktree-hash>/` is a bare Git worktree snapshot store. Message and revert data in the
  database refer to its tree hashes. It is needed for historical file checkpoint/revert fidelity, but not for
  discovering or continuing the conversation. Its location is project/worktree-scoped, not session-scoped
  ([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/snapshot/index.ts#L74-L84)). OpenCode runs Git GC
  with a seven-day prune horizon there
  ([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/snapshot/index.ts#L299-L315)).
- `tool-output/<tool-id>` holds full text for oversized tool results. The database message retains the preview and
  path, so this file is not needed for model-context resume, but losing it makes the historical “read full output”
  path dead. OpenCode deletes these files after seven days
  ([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/tool/truncate.ts#L13-L20),
  [source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/tool/truncate.ts#L54-L72)).

The first adapter should snapshot only the database and promise conversational resume. Snapshot Git stores and
tool-output cannot be assigned faithfully to a single session with the current five-axis contract; adding them
would be a separately specified project-sidecar extension.

### Mutation model and consistent snapshot design

`mutationModel` is `db-snapshot`. OpenCode opens the database in WAL mode, uses normal synchronous writes, and runs
a passive checkpoint on open
([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/core/src/database/database.ts#L22-L36)). Copying only
`opencode.db` can therefore omit committed frames still in `opencode.db-wal`; separately copying the main file,
`-wal`, and `-shm` cannot make them one point-in-time view while OpenCode is writing.
This follows SQLite's WAL model: commits may exist only in the WAL until checkpointing
([SQLite WAL documentation](https://sqlite.org/wal.html#how_wal_works)), while the Online Backup API produces a
consistent snapshot of a live database without holding one long write-blocking lock
([SQLite backup documentation](https://sqlite.org/backup.html)).

Plan:

1. Extend the core representation for `db-snapshot`; `SessionUnit` currently assumes one user-resumable session and
   a stat-walked file set. A database snapshot is one store-wide unit containing many session IDs. Do not encode it
   as a fake session or query/export rows into per-session JSON.
2. Open the source read-only and use SQLite's online backup API to create a temporary native SQLite database in the
   archive staging area. The backup API reads a consistent view and incorporates committed WAL frames. Do not use
   `VACUUM INTO`, because page re-layout is an unnecessary transformation, and do not ask OpenCode to checkpoint.
3. Close the backup, verify `PRAGMA quick_check` returns `ok`, then zstd-compress it into an append-only path:
   `<machine>/opencode/snapshots/<UTC-basic>-<content-sha256>/opencode.db.zst`, where `<UTC-basic>` is
   `YYYYMMDDTHHmmss.SSSZ`. Hashing the completed backup deduplicates unchanged database state; the timestamp makes
   snapshots human-orderable. Never archive `opencode.db-wal` or `opencode.db-shm`; the completed backup is
   self-contained.
4. Capture a small Packbat-owned manifest beside the compressed database containing source path, OpenCode version,
   snapshot time, hash, byte size, and the session IDs/timestamps observed in that same backup. The manifest is an
   index, not the payload. The database remains raw, native OpenCode state.
5. Restore only while the destination database is absent and no OpenCode process is using that path. Decompress to
   a sibling temporary file, validate it, remove any stale destination `-wal`/`-shm`, then atomically rename it to
   the resolved database path. Existing live DBs must not be overwritten or merged. A safe side-by-side recovery can
   instead restore to a new absolute path and print
   `OPENCODE_DB=<restored-path> opencode -s <session-id>`.

Before implementation, prove that the chosen SQLite backup binding exists at the repository's Node 22.15 floor. If
the built-in `node:sqlite` backup API is unavailable at that exact floor, flag the required dependency or runtime
floor change loudly; shelling out to a user-installed `sqlite3` would break turnkey operation.

### Resume, export/import, share, and path coupling

The direct resume command is `opencode -s <session-id>`; `--session` is explicitly “session id to continue”
([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/cli/cmd/tui.ts#L85-L98)). The CLI validates the
typed ID with an exact session GET before starting the TUI
([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/cli/tui/validate-session.ts#L14-L29)). For an automated
proof, `opencode run --session <session-id> <prompt>` exercises the same continuation flag without an interactive
terminal.

The database filename is load-bearing for default discovery, but `OPENCODE_DB` provides an explicit alternate
target. Rows also preserve absolute project/worktree directories. Exact source filenames from the retired JSON
tree are not load-bearing in current releases. For the least surprising working context, resume from the original
project directory even though exact-ID lookup is database-backed.

`db-snapshot` has no meaningful per-session `restoreTarget`. Its store-wide restore target is the resolved database
path above; a side-by-side recovery instead targets the absolute path supplied through `OPENCODE_DB`.

`opencode export <session-id>` emits `{ info, messages }`
([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/cli/cmd/export.ts#L240-L291)). `opencode import` keeps
the session/message/part IDs but rewrites project, directory, and relative path to the importing instance before
upserting rows
([source](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/opencode/src/cli/cmd/import.ts#L167-L223)). This proves that the
public session representation is sufficient for a resumable conversation, and share URLs feed the same importer.
It omits other DB-owned state described above and rewrites instance paths, so export/import is a transformed
portability format, not Packbat's raw-at-rest archive format. `/share` uploads
the conversation history, messages, and session metadata to a public link until `/unshare`
([docs](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/web/src/content/docs/share.mdx#L14-L38),
 [docs](https://github.com/anomalyco/opencode/blob/8d78715d64d6f2401e5dfcd93745d082aaa1d163/packages/web/src/content/docs/share.mdx#L81-L107)); it is corroborating
resume evidence, not a local restore mechanism.

### Retention risk

No automatic age/count retention for session rows was found in `v1.17.5`. Archive only sets
`session.time_archived`; deletion is explicit through `opencode session delete <session-id>`. Upstream issue
[#22110](https://github.com/anomalyco/opencode/issues/22110) reports unbounded session growth and requested pruning;
it was closed as not planned. Its listed `storage/` paths are from the retired JSON era, so the report supports the
retention problem but not the current physical layout. Distinct seven-day cleanup applies to snapshot Git objects
and spilled tool output, not to conversational sessions.

Recommended adapter string:

```text
OpenCode does not automatically prune session history; explicit deletion removes it from the shared SQLite database.
```

### Resume-proof case

1. Run against an isolated `XDG_DATA_HOME` and a dedicated absolute `OPENCODE_DB`; create one real non-interactive
   session containing a random codename, and capture its `ses_...` ID. Do not point the test at the user's normal
   database.
2. Assert that the database is in WAL mode. Keep OpenCode capable of writing while Packbat syncs, so the test proves
   the online snapshot path rather than a lucky closed-database copy. Record the completed snapshot bytes/hash.
3. Remove the isolated database plus any `-wal`/`-shm` sidecars, then restore the snapshot to the same absolute
   `OPENCODE_DB` path. Assert the restored DB bytes equal the completed backup artifact, not the concurrently
   mutating source main-file bytes.
4. From the original project directory, run
   `opencode run --session <id> "What fictional project codename was provided? Reply with only the codename."`.
5. Discovery is proved only if the command exits zero, continues the same `ses_...` ID, and returns the codename.
   Also assert `opencode export <id>` succeeds from the restored database. The archive snapshot must remain
   byte-identical after resume mutates the live restored DB.

## Gemini CLI

### Store root, override, and project identity

The default adapter root is `~/.gemini/tmp`. `GEMINI_CLI_HOME` replaces the home-directory component, so the
override is `${GEMINI_CLI_HOME}/.gemini/tmp`, not `${GEMINI_CLI_HOME}/tmp`
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/utils/paths.ts#L13-L28),
[source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/storage.ts#L54-L60),
[source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/storage.ts#L154-L185)).
The adapter resolver is therefore:

```text
join(env.GEMINI_CLI_HOME || home, ".gemini", "tmp")
```

Released `v0.50.0` docs still call the next component `<project_hash>`
([docs](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/docs/cli/session-management.md#L9-L22)),
but current source assigns a short project slug through `~/.gemini/projects.json`. On initialization it maps the
absolute project root to that slug, uses `tmp/<slug>`, and copies any legacy SHA-256 directory into the new slug
directory
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/storage.ts#L225-L273)). Each slug directory also
contains `.project_root`, the normalized absolute project path. If `projects.json` is absent or stale, the registry
scans these markers and self-heals the mapping
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/projectRegistry.ts#L159-L235),
[source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/projectRegistry.ts#L238-L301),
[source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/projectRegistry.ts#L304-L410)).

Current shape:

```text
${GEMINI_CLI_HOME-or-home}/.gemini/
├── projects.json
└── tmp/
    └── <project-slug>/
        ├── .project_root
        ├── chats/
        ├── logs/
        ├── tool-outputs/
        └── <session-id>/
```

Keep `storeRoot` at `.gemini/tmp`. Attach `.project_root` to each session from that project; do not archive or
restore the global, rewrite-in-place `projects.json` as a per-session sidecar.

### Main record and mutation model

The main automatic-session path is:

```text
tmp/<project-slug>/chats/session-<YYYY-MM-DDTHH-MM>-<uuid-first-8>.jsonl
```

The first line is metadata containing the full `sessionId`, project identity, timestamps, kind, and directories.
Later lines are complete messages/tool-call records, `$set` state or history changes, and `$rewindTo` records
([types](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingTypes.ts#L44-L140),
[reader](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L133-L400)). Creation writes
the metadata header and chooses the filename above
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L467-L535)). Every
subsequent record uses `appendFileSync`; messages, tool-call changes, rewinds, and even whole-history replacement are
encoded as new records rather than rewriting the file
([writer](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L550-L635),
[tool records](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L699-L760),
[rewind/history](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L851-L954)). Resuming continues
the same file path and appends a metadata update before new records
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L418-L465)).

The correct automatic-session `mutationModel` is therefore `append-file`. Legacy top-level `.json` sessions remain
readable; on resume Gemini writes their state into a new `.jsonl` sibling and continues there rather than mutating
the legacy JSON file
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/services/chatRecordingService.ts#L436-L460)).

This also resolves the ticket's “JSON checkpoints plus append log” ambiguity. Manual tagged checkpoints are
separate `checkpoint-<encoded-tag>.json` files written with overwrite semantics. They are loaded inside an active
TUI with `/resume resume <tag>` or the `/chat` alias, not by CLI `gemini --resume`
([checkpoint source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/core/logger.ts#L285-L390),
[commands](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/ui/commands/chatCommand.ts#L34-L68)). Do not combine those
rewrite files with automatic sessions under one adapter-wide mutation model.

### Full session inventory

One automatic-session unit should contain the following paths, relative to the `.gemini/tmp` adapter root:

- Main: `<slug>/chats/session-*.jsonl`, or a legacy top-level `session-*.json`. The filename carries only the
  first eight UUID characters; `SessionUnit.id` must come from the full `sessionId` in the first JSONL record or
  legacy JSON object.
- Project locator sidecar: `<slug>/.project_root`.
- Subagent sidecars: `<slug>/chats/<full-parent-session-id>/<subagent-session-id>.jsonl`.
- Activity log: `<slug>/logs/session-<full-session-id>.jsonl`.
- Full oversized tool outputs: `<slug>/tool-outputs/session-<full-session-id>/**`.
- Session-scoped working state: `<slug>/<full-session-id>/plans/**`, `tracker/**`, and `tasks/**`.

Gemini's own deletion routine groups those nested records and artifact trees with the parent session
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/utils/sessionOperations.ts#L56-L169),
[source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/utils/sessionOperations.ts#L210-L293)). Storage constructs the
plans/tracker/tasks paths from the full session ID
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/config/storage.ts#L321-L359)). The main JSONL alone is
sufficient for discovery and model-context continuation; sidecars restore subagent traces, plans, trackers,
activity logs, and full output that was too large for the transcript.

Do not attach these separate project stores to the automatic session unit:

- `<slug>/checkpoint-<tag>.json`: manual tagged conversation checkpoints, `rewrite-file`.
- `<slug>/checkpoints/*.json`: file-edit rollback checkpoints used by `/restore`.
- `~/.gemini/history/<slug>/`: shadow Git history used by file checkpoint restore.

They are not consulted by `gemini --resume`; including them would mix mutation models and project-wide state
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/core/src/utils/checkpointUtils.ts#L15-L157),
[docs](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/docs/cli/checkpointing.md#L8-L35)).

### Enumeration and restore target

The adapter must relax the current contract comment that enumeration never reads contents. Gemini's filename has
only an eight-character UUID prefix, so it cannot supply the exact ID accepted by `--resume`. Enumeration should:

1. Walk only each project's top-level `chats/` for `session-*.jsonl` and legacy `session-*.json`.
2. Read the JSONL metadata line, or legacy JSON object, to obtain full `sessionId` and `kind`; exclude subagent
   records as roots.
3. Group duplicate legacy JSON/converted JSONL records by full UUID, choosing JSONL as main and retaining the legacy
   JSON as a sidecar if both exist.
4. Attach `.project_root` and every matching session-owned path listed above.

Gemini's own discovery likewise filters top-level `session-*.json|jsonl` and parses each record
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/utils/sessionUtils.ts#L237-L354)).

`restoreTarget(storeRoot, relPath)` is `join(storeRoot, relPath)`. Both project placement and filename shape are
load-bearing: Gemini chooses the project from the current cwd through `projects.json`/`.project_root`, and it only
discovers matching files directly below that project's `chats/`. Preserve every relative path and basename. A
restore on another machine also needs the same absolute project path for `.project_root` to self-heal without
transforming state.

### Resume identifiers and hints

The stable hint is:

```text
Run from the original project directory:
gemini --resume <full-session-uuid>
```

`gemini --resume` is coerced to `latest`; `gemini --resume latest` chooses the greatest start time; a number selects
the 1-based index in oldest-first order; and a UUID requires exact equality
([flag](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/config/config.ts#L400-L419),
[selector](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/utils/sessionUtils.ts#L360-L403),
[selector](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/utils/sessionUtils.ts#L450-L568)). Index and `latest` are
unstable as sessions are added or removed; archive identity must be the full UUID. Tags are only the manual
in-session checkpoint mechanism described above, not a `--resume` selector.

### Retention risk

Gemini has an explicit automatic deletion risk. Cleanup is enabled by default with `maxAge: "30d"`, a one-day
safety floor, and no default count limit
([settings schema](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/config/settingsSchema.ts#L389-L436),
[docs](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/docs/cli/session-management.md#L148-L186)). Startup launches cleanup in the
background
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/gemini.tsx#L669-L672)); expired or count-excess sessions
are deleted with their associated logs, tool outputs, subagents, plans, trackers, and tasks
([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/utils/sessionCleanup.ts#L99-L260),
[source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/utils/sessionCleanup.ts#L299-L383)). Unparseable or content-empty
records can also become cleanup candidates. Manual tagged checkpoints are outside this cleanup path.

Recommended adapter string:

```text
Gemini CLI deletes sessions older than general.sessionRetention.maxAge (30 days by default) at startup, including their associated artifacts.
```

### Resume-proof case

1. Create an isolated home and disposable project. Set `GEMINI_CLI_HOME=<temp>/gemini-home`; the expected adapter
   root is `<temp>/gemini-home/.gemini/tmp`. Make authentication available using the existing resume-proof
   credential mechanism, without reading or writing the user's normal session store.
2. From the project, run
   `gemini -p "The fictional continuity codename is <random>. Remember it." --output-format json`.
3. Find the one new top-level `session-*.jsonl`, parse its first line for the full `sessionId`, and retain the main
   file's exact bytes and relative path. Assert the basename contains only `sessionId.slice(0, 8)`.
4. Run packbat sync, remove the main transcript and its session-owned sidecars while leaving credentials alone, then
   restore by full UUID. Assert the main file and sidecars return at their exact relative paths and that the main
   bytes equal the pre-sync bytes.
5. From the same project run `gemini --list-sessions`; the restored UUID prefix must appear. This proves
   project-scoped discovery before another model call.
6. Run
   `gemini --resume <full-uuid> -p "Reply only with the continuity codename." --output-format json`. Assert exit 0
   and that the response contains the random codename.
7. Assert the restored JSONL still begins with every archived byte and has grown by valid appended records. Assert
   the compressed archive is unchanged. Use the full UUID, not bare `--resume`: missing `latest` falls back to a new
   session and could make a false-positive proof
   ([source](https://github.com/google-gemini/gemini-cli/blob/8d9733d531c70284d77b09e1ff5e61dde2d61ebc/packages/cli/src/gemini.tsx#L203-L328)).

## Cursor CLI: contract sketch

- `id: "cursor"`; `displayName: "Cursor CLI"`; proposed root `~/.cursor/projects` with no known environment override.
- Detect `*/agent-transcripts/*.jsonl`; treat the transcript filename/relative project placement as load-bearing until source proves otherwise.
- Provisional `mutationModel: "append-file"` because the observed target is JSONL; verify prefix stability before implementing.
- Enumerate one transcript per unit, restore the exact relative path, and derive an ID only after matching it to Cursor's public chat ID.
- Retention is unknown; proposed hint `cursor-agent --resume=<chat-id>`; no adapter before a hands-on/source resume proof.

## Open questions before implementation

- Should `db-snapshot` be a new store-wide archive unit, or should the five-axis contract be generalized so store
  snapshots and per-session units are different explicit types? Treating a whole DB as `SessionUnit` is misleading.
- Does the chosen no-dependency SQLite backup implementation work on Node 22.15 on macOS, Linux, and Windows?
- Does issue #22 want conversational resume only for OpenCode, or full checkpoint fidelity including project-scoped
  `snapshot/` Git stores and seven-day `tool-output/` spill files?
- Restore policy needs a product decision for a non-empty destination DB. Raw whole-database restore cannot safely
  merge one archived session into newer live state; export/import can merge but violates raw-at-rest semantics.
- Gemini requires a narrow exception to content-free enumeration so the adapter can parse the first metadata line
  and recover the full UUID that `--resume` accepts.
- Decide whether Gemini's first adapter promises full associated-artifact fidelity or only conversation resume. A
  main transcript plus `.project_root` is sufficient for resume; the listed sidecars preserve more of the session.
- Custom Gemini plan directories can live inside the project rather than `.gemini/tmp`; they are not necessary for
  conversation resume and cannot be represented under the proposed store root.
