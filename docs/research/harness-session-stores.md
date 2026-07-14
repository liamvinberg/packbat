# AI-agent CLI session stores and resume mechanics

Research date: 2026-07-12 (Europe/Stockholm).

This report is deliberately structural. Local inspection covered paths, filenames, file sizes, mtimes, JSON key sets, value types, and equality/count checks. It did not retain or reproduce conversation text or other values from session records. Commands were run against Claude Code 2.1.205, Codex CLI 0.144.1, opencode 1.17.5, and pi 0.80.5. Gemini CLI and Cursor CLI were not installed.

Confidence labels:

- **Local + source**: verified against this machine and current first-party source or docs.
- **Source only**: verified against current first-party source or docs, but the harness was not installed locally.
- **Docs only**: public behavior is documented, but the local representation is not disclosed.
- **Inferred**: a conclusion from structural evidence that is not promised by first-party docs or source.

## Comparison matrix

| Harness | Store path | File format and mutation | Session identity | Retention | Resume conditions, coupling, and indexes | Confidence |
|---|---|---|---|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; optional `<session-id>/subagents/`, `<session-id>/tool-results/` | Main transcript and subagents are JSONL event logs, saved continuously. Records are appended in ordinary use. Current docs say `/cd` and worktree moves relocate the transcript. Sidecar and cleanup operations create, move, or delete other paths. | UUID-form filename plus `sessionId` in transcript records. All 275 locally checked main files had exactly one `sessionId`, equal to the filename UUID. | Startup cleanup, default 30 days and minimum 1 in current 2.1.205 docs. It deletes the transcript and listed per-session application data after the cutoff. `history.jsonl` is kept indefinitely. | Direct ID lookup is scoped to the current project directory and its git worktrees. `--continue` is the newest session in the current directory. The picker can widen to all local projects. No session database was present or documented; `history.jsonl` is prompt recall, not a resume index. Exact encoded project placement is therefore load-bearing for normal direct-ID discovery. | **Local + docs**, with append behavior partly inferred from current docs and historical writer evidence because Claude Code source is closed. |
| Codex CLI | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`; archived files are flattened into `$CODEX_HOME/archived_sessions/` | Rollouts are JSONL. The recorder opens with append/create, writes one JSON plus newline, and flushes. Archive/unarchive rename the rollout; unarchive touches mtime. `state_5.sqlite` and its WAL mutate transactionally. `session_index.jsonl` appends name updates but is atomically rewritten when names are removed. | Filename UUID equals first `session_meta.payload.id` in all 229 locally checked active and archived files. | No automatic rollout retention or retention setting was found in current source/config. Shell snapshots, not rollouts, have a 3-day cleanup. An upstream rollout-retention request remains open. | Direct UUID lookup prefers SQLite, verifies the embedded ID, then falls back to recursively scanning active `sessions/` filenames and repairs DB metadata. Cwd filters picker and `--last`, not direct UUID. Archived threads are rejected until `codex unarchive <id>`. `session_index.jsonl` supplies names, not UUID lookup. | **Local + source**. |
| Gemini CLI | `~/.gemini/tmp/<project-short-id>/chats/session-<minute-timestamp>-<uuid-prefix>.jsonl`; `~/.gemini/projects.json` maps absolute project roots to slugs | JSONL event log: metadata header followed by message, `$set`, and `$rewindTo` records. Normal writes use append. Legacy JSON is migrated. | Full UUID in metadata; filename carries its first 8 characters. | Enabled by default: max age 30 days, minimum 1 day; max count unset. Startup cleanup excludes the active session and removes expired/corrupt sessions plus associated artifacts. | `gemini --resume latest|UUID|index` discovers only the current project slug. `--session-file` imports from elsewhere but assigns a new UUID/project identity. The absolute-root-to-slug mapping is path and local-config coupled. | **Source only**. |
| Cursor CLI | Not disclosed by official docs. No `~/.cursor` existed locally. | Not disclosed. Official docs expose JSON output, not the persistence representation. | Public CLI resume handle is a chat ID; JSON output exposes a UUID `session_id`. | Not disclosed. | `cursor-agent resume` resumes latest; `cursor-agent --resume=<chat-id>` resumes by ID; `cursor-agent ls` lists chats. Official slash-command docs mention previous chats by folder name, but do not establish path or machine coupling. | **Docs only**, low confidence for storage internals. |
| opencode | XDG data DB, locally `~/.local/share/opencode/opencode.db` with `-wal` and `-shm`; `OPENCODE_DB` can override | Normalized SQLite tables (`session`, `message`, `part`, and related tables), WAL mode. Updates are transactional mutations, not raw append-only session files. | `session.id`, referenced by messages/parts and associated with project, workspace, and directory. | No automatic age/count cleanup was documented or found in current source. Archive sets `session.time_archived`; delete is explicit. | `-c` selects newest root session for the current instance/project. `-s <id>` performs exact session lookup in current source. A faithful raw restore is a consistent SQLite database restore, not a single-session file copy. | **Local + source**. Local DB contained 2 sessions, 10 messages, 33 parts, and 0 archived sessions. |
| pi | Default: `~/.pi/agent/sessions/--<encoded-cwd>--/<sanitized-ISO>_<uuid>.jsonl`. With `--session-dir` or `PI_CODING_AGENT_SESSION_DIR`, the override is the exact directory and the file sits directly beneath it. | JSONL header plus tree entries. Normal records append. Old schema versions can be rewritten during automatic migration; branch/fork creates a new file. | Header `id` UUID, repeated in filename; entries have `id` and `parentId`. | No automatic retention was documented or found. Picker deletion tries OS trash, then unlink. | `-c` and `-r` are current-project scoped. `--session <path|id>` accepts a direct path or ID/partial UUID and can fall back to a global scan, so direct resume is not cwd-bound. Header `cwd` still affects resumed working context unless overridden. | **Local + source**. Local store contained 327 JSONL session files. |

Primary survey sources: [Gemini storage and project slugs](https://github.com/google-gemini/gemini-cli/blob/f354eebaf43b25bacb176007e449bb9a638fd101/packages/core/src/config/storage.ts#L181-L272), [Gemini JSONL writer](https://github.com/google-gemini/gemini-cli/blob/f354eebaf43b25bacb176007e449bb9a638fd101/packages/core/src/services/chatRecordingService.ts#L133-L274), [Gemini resume discovery](https://github.com/google-gemini/gemini-cli/blob/f354eebaf43b25bacb176007e449bb9a638fd101/packages/cli/src/utils/sessionUtils.ts#L409-L543), [Gemini retention](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md#session-retention), [Cursor sessions](https://docs.cursor.com/en/cli/overview#sessions), [Cursor parameters](https://docs.cursor.com/en/cli/reference/parameters), [opencode data directory](https://github.com/anomalyco/opencode/blob/a244d82abacc1f208e53d59b4061c359a9706de7/packages/core/src/global.ts#L1-L31), [opencode database](https://github.com/anomalyco/opencode/blob/a244d82abacc1f208e53d59b4061c359a9706de7/packages/core/src/database/database.ts#L17-L54), [opencode session schema](https://github.com/anomalyco/opencode/blob/a244d82abacc1f208e53d59b4061c359a9706de7/packages/core/src/session/sql.ts#L22-L79), [pi session format](https://github.com/badlogic/pi-mono/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/session-format.md), and [pi session lookup](https://github.com/badlogic/pi-mono/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/main.ts#L150-L205).

## Claude Code

### Layout and directory encoding

Current official documentation gives the canonical path as:

```text
~/.claude/projects/<project>/<session-id>.jsonl
```

`<project>` is the absolute working-directory path with every non-alphanumeric character replaced by `-`. For example, `/Users/liamvinberg/projects/blotter` maps to `-Users-liamvinberg-projects-blotter`. This is a lossy encoding: `/`, `.`, spaces, underscores, and other punctuation all collapse to `-`. The local store had 25 project directories. Of 264 main transcripts with a readable early `cwd`, 263 mapped exactly to their parent project directory. The one mismatch was associated with the relocation behavior discussed below. The official format and path rule are documented in [Manage sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).

Main files are named `<uuid>.jsonl`. A session may also own a same-named directory:

```text
projects/<encoded-cwd>/<uuid>.jsonl
projects/<encoded-cwd>/<uuid>/subagents/agent-<hex>.jsonl
projects/<encoded-cwd>/<uuid>/tool-results/<opaque-file>
```

Local inspection found:

| Object | Count |
|---|---:|
| Main transcripts directly under project directories | 275 |
| Same-UUID sidecar directories | 93 |
| Sidecar directories with a matching parent transcript | 91 |
| Orphan sidecar directories without the parent transcript | 2 |
| Sidecar directories containing `subagents/` | 85 |
| Subagent JSONL files | 1,555 |
| Sidecar directories containing `tool-results/` | 35 |
| Spilled tool-result files | 242 |

The two local orphan directories match the failure shape reported in Claude Code issue [#59248](https://github.com/anthropics/claude-code/issues/59248), but local structure alone cannot establish why their parents disappeared.

Representative structural metadata, included without record values:

| Path | Size | mtime |
|---|---:|---|
| `~/.claude/projects/-Users-liamvinberg-projects-tesser/<uuid>.jsonl` | 19,777,589 bytes | 2026-06-13 13:18:32 +0200 |
| `~/.claude/projects/-Users-liamvinberg-projects-blotter/<uuid>.jsonl` | 440,278 bytes | 2026-07-12 20:05:42 +0200 |
| `~/.claude/.last-cleanup` | 24 bytes | 2026-07-12 19:59:34 +0200 |

### JSONL record shapes

Claude explicitly calls the entry format internal and version-unstable. The following is the union of keys observed locally in 2.1.205, not a compatibility schema. A key in a union is optional unless stated otherwise.

Common conversation records:

```text
user: type, uuid, parentUuid, sessionId, timestamp, cwd, gitBranch,
      version, userType, entrypoint, isSidechain, message,
      promptId, promptSource, permissionMode, isMeta,
      isCompactSummary, isVisibleInTranscriptOnly,
      sourceToolAssistantUUID, sourceToolUseID, toolUseResult,
      toolDenialKind, origin, imagePasteIds, queuePriority,
      interruptedMessageId, sessionKind, session_id, slug,
      stackedExpansion, stackedOriginalInput

assistant: type, uuid, parentUuid, sessionId, timestamp, cwd, gitBranch,
           version, userType, entrypoint, isSidechain, message,
           requestId, error, apiErrorStatus, isApiErrorMessage,
           attributionAgent, attributionMcpServer, attributionMcpTool,
           attributionSkill, sessionKind, session_id, slug

system: type, subtype, uuid, parentUuid, sessionId, timestamp, cwd,
        gitBranch, version, userType, entrypoint, isSidechain, isMeta,
        content, level, durationMs, messageCount, compactMetadata,
        logicalParentUuid, requestId, trigger, direction, retryAttempt,
        retryInMs, maxRetries, error, hookCount, hookErrors, hookInfos,
        hookAdditionalContext, hasOutput, preventedContinuation,
        stopReason, toolUseID, pendingBackgroundAgentCount,
        pendingWorkflowCount, apiRefusalCategory, apiRefusalExplanation,
        refusedUserMessageUuid, retractedMessageUuids, originalModel,
        fallbackModel, sessionKind, session_id, slug
```

`message` shapes observed:

```text
user.message: role, content
assistant.message: id, type, role, model, content, stop_reason,
                   stop_sequence, usage, container, context_management,
                   diagnostics, stop_details

content item variants:
text: text, type
thinking: thinking, signature, type
tool_use: id, name, input, caller, type
tool_result: tool_use_id, content, is_error, type
image/document: source, type
fallback: from, to, type
```

Compaction summaries are not a separate top-level `summary` type in the inspected version. They are `user` records with `isCompactSummary` and `isVisibleInTranscriptOnly`; the observed top-level key set was:

```text
cwd, entrypoint, gitBranch, isCompactSummary, isSidechain,
isVisibleInTranscriptOnly, message, parentUuid, promptId, sessionId,
slug, timestamp, type, userType, uuid, version
```

Additional metadata types and their observed key unions:

```text
agent-name: agentName, sessionId, type
ai-title: aiTitle, sessionId, type
attachment: attachment, cwd, entrypoint, gitBranch, isSidechain,
            parentUuid, sessionId, sessionKind, session_id, slug,
            timestamp, type, userType, uuid, version
bridge-session: bridgeSessionId, lastSequenceNum, sessionId, type
custom-title: customTitle, sessionId, type
file-history-snapshot: isSnapshotUpdate, messageId, snapshot, type
last-prompt: lastPrompt, leafUuid, sessionId, type
mode: mode, sessionId, type
permission-mode: permissionMode, sessionId, type
pr-link: prNumber, prRepository, prUrl, sessionId, timestamp, type
queue-operation: content, operation, sessionId, timestamp, type
relocated: relocatedCwd, sessionId, type
worktree-state: sessionId, type, worktreeSession
```

Subagent JSONL adds `agentId` to conversation records and may begin with:

```text
fork-context-ref: agentId, contextLength, parentLastUuid,
                  parentSessionId, type
```

The main and subagent samples did not have a fixed first or last record type. Three main samples began with `mode`, `last-prompt`, and `mode`; they ended with `mode`, `system`, and `bridge-session`. Three subagent samples began with `user`; two ended with `assistant` and one with `user`. This rules out using the first or last record type as a validity sentinel.

### Mutation semantics

Official docs say sessions are saved continuously and that deleting `projects/` removes resume/continue capability. The historical writer excerpt in issue [#23710](https://github.com/anthropics/claude-code/issues/23710) names an `appendEntry` path. Together with valid line-oriented files and increasing size/mtime across active files, this supports ordinary append behavior, but it is not a public append-only guarantee.

During this inspection, one active main transcript grew from 2,343,773 to 2,370,352 bytes and its mtime advanced from 19:58:41 to 20:09:43 +0200. The other four sampled main files remained byte-size and mtime stable. Growth is consistent with append, but no initial prefix hash was captured for that Claude file, so it does not by itself exclude a rewrite.

Known non-append operations around a session:

- From 2.1.169, `/cd` relocates a transcript to the new directory's project storage. From 2.1.198, entering or exiting a worktree does the same. See [session picker relocation](https://code.claude.com/docs/en/sessions#where-the-session-picker-looks) and [worktree transcript relocation](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree).
- Startup retention deletes whole session and sidecar paths after their cutoff.
- `claude project purge` deletes transcripts and related project state after confirmation.
- `file-history/`, `plans/`, `tasks/`, `session-env/`, caches, and shell snapshots are independent mutable or disposable paths.

No locally active Claude process was instrumented, so this investigation did not prove whether rename, compaction, or metadata changes ever rewrite an existing main JSONL in place. Treat ordinary append as observed behavior, not a contract.

### Session identity and resume mechanics

The filename UUID is the session ID. In all 275 checked main transcripts, every record carrying `sessionId` used one unique value and that value equaled the filename UUID. Record `uuid` is an event/message node identity, not the session identity. Some current records also contain `session_id`; its presence is not needed to identify the file.

Resume is project-scoped:

- `claude --continue` selects the most recent session in the current directory.
- `claude --resume <session-id>` looks in the current project directory and its git worktrees. Running it from an unrelated project returns no conversation even if that UUID exists elsewhere.
- The picker defaults to the current worktree. `Ctrl+W` widens to repository worktrees and `Ctrl+A` widens to every project stored on the machine.
- Non-interactive and Agent SDK sessions may be absent from the picker but remain directly resumable by ID.

These are explicit in [Claude Code's session documentation](https://code.claude.com/docs/en/sessions#resume-a-session). There is no `sessions.sqlite` or equivalent under the inspected `~/.claude`; current docs describe transcript-file discovery. `history.jsonl` has keys `display`, `pastedContents`, `project`, `sessionId`, and `timestamp` locally, but the docs define it as prompt recall. It is retained independently and deleting it only loses up-arrow recall, not resume. See [Claude application data](https://code.claude.com/docs/en/claude-directory#kept-until-you-delete-them) and [clear local data](https://code.claude.com/docs/en/claude-directory#clear-local-data).

The store is local, but no hardware or installation identifier was observed in transcript identity or documented as a resume condition. Moving to another machine still requires a compatible Claude Code version, credentials, the right config root, and a project path that resolves to the expected encoded directory. The absence of a hardware ID is structural evidence, not a portability guarantee.

### What belongs in a faithful Claude archive

First-party docs now classify the application data precisely:

| Path | Relationship to session fidelity |
|---|---|
| `projects/<project>/<session>.jsonl` | **Required for resume.** Full transcript. |
| `projects/<project>/<session>/subagents/` | **Session-owned.** Subagent transcripts; should travel with the parent for complete provenance. |
| `projects/<project>/<session>/tool-results/` | **Session-owned.** Large outputs spilled outside the main JSONL. |
| `file-history/<session>/` | Not required to resume conversation, but required for checkpoint restore/rewind fidelity. |
| `plans/`, `tasks/`, `paste-cache/`, `image-cache/`, `debug/` | Session-associated application data. Current docs say deleting it loses nothing user-facing, but it may be needed for a byte-faithful archive of the harness state. |
| `session-env/` | Per-session environment metadata; not user-facing after deletion. |
| `shell-snapshots/` | Bash environment capture; removed on clean exit and stale crash leftovers swept. Not required for historical resume. |
| `history.jsonl` | Prompt recall only, retained indefinitely; not a resume index. |
| `todos/`, `statsig/`, `logs/` | Legacy in current docs, no longer written, removed by cleanup. |
| `stats-cache.json` | Aggregate usage totals, not session resume. |
| `~/.claude.json`, settings, plugins, auth | Harness configuration, not session payload. Necessary to recreate the same configured client, but not intrinsic to one session archive. |

The definitive current classification is [Explore the `.claude` directory](https://code.claude.com/docs/en/claude-directory#application-data).

### Retention and reported bugs

Current 2.1.205 behavior documented by Anthropic:

- `cleanupPeriodDays` defaults to 30 and has a minimum of 1.
- At startup, Claude deletes transcripts, their subagents/tool-results, file-history, and the other listed application data older than the cutoff.
- `history.jsonl` and `stats-cache.json` are not covered by the sweep.
- `0` now fails validation.
- If settings cannot be read or parsed, 2.1.203 and newer pause cleanup and warn. Before 2.1.203, cleanup used the 30-day default in that state, which could violate a configured longer period. Current docs state that files newer than 30 days were not removed by that bug.

Sources: [available settings](https://code.claude.com/docs/en/settings#available-settings) and [cleanup scope](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically).

Two issue reports must be scoped historically and evidentially:

- [#59248](https://github.com/anthropics/claude-code/issues/59248) is an open user report against extension 2.1.141. It reports silent hard deletion with no warning or recovery, a rewritten `.last-cleanup`, orphaned subagent directories, and missing sessions apparently newer than the documented cutoff. It is detailed but not maintainer-confirmed, and its newer-than-30-day observation conflicts with current docs.
- [#23710](https://github.com/anthropics/claude-code/issues/23710) is a closed report against 2.1.34. In that version, setting `cleanupPeriodDays: 0` reportedly short-circuited transcript writes even though the schema described 0 as disabling cleanup. Current docs instead reject 0, so this is a historical failure mode, not current supported semantics.

## Codex CLI

### Layout

Current rollouts use:

```text
$CODEX_HOME/sessions/YYYY/MM/DD/
  rollout-YYYY-MM-DDThh-mm-ss-<thread-uuid>.jsonl

$CODEX_HOME/archived_sessions/
  rollout-YYYY-MM-DDThh-mm-ss-<thread-uuid>.jsonl
```

The active year/month/day directories and flat archive root are constants in [Codex rollout source](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/rollout/src/lib.rs#L17-L18). Local state contained 42 active rollout files (41,988 KiB) and 187 archived rollout files (396,864 KiB). `state_5.sqlite.threads` contained exactly 229 rows, split into 42 active and 187 archived, matching the files.

Representative structural metadata:

| Path | Size | mtime |
|---|---:|---|
| `~/.codex/archived_sessions/rollout-2026-07-11T19-12-53-<uuid>.jsonl` | 18,915,173 bytes | 2026-07-12 00:52:00 +0200 |
| `~/.codex/sessions/2026/07/12/rollout-2026-07-12T19-59-10-<uuid>.jsonl` | 345,689 bytes | 2026-07-12 20:04:27 +0200 |

### JSONL record shapes

Every top-level line has `timestamp`, `type`, and `payload` in the inspected current files. Top-level types were:

```text
session_meta, turn_context, response_item, event_msg, compacted,
world_state, inter_agent_communication_metadata
```

Structural payload shapes observed locally:

```text
session_meta:
  id, session_id, timestamp, cwd, cli_version, source, originator,
  model_provider, git, base_instructions, context_window, history_mode,
  thread_source, dynamic_tools, forked_from_id, parent_thread_id,
  agent_nickname, agent_path, multi_agent_version, memory_mode

turn_context:
  turn_id, cwd, current_date, timezone, model, effort, summary,
  approval_policy, sandbox_policy, file_system_sandbox_policy,
  permission_profile, workspace_roots, collaboration_mode,
  multi_agent_mode, multi_agent_version, approvals_reviewer,
  personality, realtime_active, comp_hash

response_item payload variants:
  message: type, role, content, id, phase,
           internal_chat_message_metadata_passthrough
  reasoning: type, id, content, summary, encrypted_content,
             internal_chat_message_metadata_passthrough
  function_call: type, id, call_id, name, namespace, arguments,
                 internal_chat_message_metadata_passthrough
  function_call_output: type, call_id, output,
                        internal_chat_message_metadata_passthrough
  custom_tool_call: type, id, call_id, name, input, status,
                    internal_chat_message_metadata_passthrough
  custom_tool_call_output: type, call_id, output,
                           internal_chat_message_metadata_passthrough
  tool_search_call: type, id, call_id, arguments, execution, status,
                    internal_chat_message_metadata_passthrough
  tool_search_output: type, call_id, execution, status, tools,
                      internal_chat_message_metadata_passthrough
  agent_message: type, author, recipient, content,
                 internal_chat_message_metadata_passthrough

event_msg payload variants observed:
  user_message, agent_message, agent_reasoning, token_count,
  context_compacted, task_started, task_complete, turn_aborted,
  thread_rolled_back, thread_settings_applied, thread_goal_updated,
  sub_agent_activity, patch_apply_end, mcp_tool_call_end,
  web_search_end

compacted:
  first_window_id, previous_window_id, window_id, window_number,
  message, replacement_history

world_state:
  full, state

inter_agent_communication_metadata:
  trigger_turn
```

The first record is `session_meta`. In all 229 checked files, its `payload.id` equaled the UUID suffix in the filename. `payload.session_id` was a string in all 229 but equaled `payload.id` in only 65, so `payload.id` is the reliable filename-correlated identity field.

### Mutation semantics

The current recorder opens rollouts read+append+create, serializes one event per line, adds a newline, and flushes each write. On resume it can add a missing terminal newline to make an unsafe tail appendable. See [recorder creation and append](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/rollout/src/recorder.rs#L1500-L1554) and [tail repair](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/rollout/src/recorder.rs#L1840-L1878).

Local observation captured one active rollout at 283,591 bytes and checked it again after further activity. It had grown to 331,265 bytes, retained the same inode, and the hash of its entire old-length prefix was unchanged. This directly verifies append behavior for that active 0.144.1 session. A later stat found the same file at 345,689 bytes.

Other mutations:

- Archive renames the active file into the flat `archived_sessions/` directory and marks the SQLite row archived. [Source](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/thread-store/src/local/archive_thread.rs#L11-L65).
- Unarchive parses the date from the filename, recreates `sessions/YYYY/MM/DD`, renames the file back, touches its mtime, and updates SQLite. [Source](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/thread-store/src/local/unarchive_thread.rs#L16-L84).
- `session_index.jsonl` uses records with `id`, `thread_name`, and `updated_at`. Naming appends a newer record; newest wins. Removing a name rewrites the file atomically. [Source](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/rollout/src/session_index.rs#L19-L104).
- `state_5.sqlite`, `goals_1.sqlite`, memory/log databases, and WAL/SHM files mutate in place as databases. They must not be treated as append-only raw session files.

### Resume lookup, cwd, and machine coupling

Both `codex resume <uuid>` and `codex exec resume <uuid>` are present in the installed 0.144.1 CLI and current [CLI source](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/cli/src/main.rs#L180-L181).

Direct UUID lookup works as follows:

1. Prefer `state_5.sqlite.threads.rollout_path`.
2. Open the candidate and verify that embedded `session_meta.payload.id` matches.
3. If the DB candidate is absent or invalid, recursively scan active `sessions/` rollout filenames.
4. Verify the embedded ID and repair/backfill DB metadata.

This is implemented in [rollout lookup](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/rollout/src/list.rs#L1311-L1525). Therefore an active, valid rollout in the canonical `sessions/` tree is the payload source of truth for direct UUID recovery. Neither `state_5.sqlite` nor `session_index.jsonl` is strictly required for that fallback. They remain important for fast listing, titles/names, archived state, app UI state, and fidelity of the original local installation.

Cwd behavior is narrower than Claude's:

- Picker and `--last` filter by current cwd unless `--all` is supplied.
- A direct UUID is accepted without cwd filtering.
- Interactive resume reads the latest cwd from SQLite or from `session_meta` and later `turn_context` records. If the caller cwd differs, it prompts and defaults to the stored session cwd.
- `-C <dir>` can set the resumed working root.

Sources: [exec resume selection](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/exec/src/lib.rs#L1459-L1575) and [interactive resume cwd handling](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/tui/src/session_resume.rs#L49-L141).

No hardware ID participates in the rollout filename or `session_meta` identity. `state_5.sqlite.rollout_path` is an absolute local path, so copying the DB verbatim to a different home can leave stale paths. The source fallback can rediscover a correctly placed active rollout and repair metadata. That makes direct UUID recovery portable in principle, while a byte-for-byte copy of the old DB is path-coupled.

### Archived sessions

`codex archive <id-or-name>` moves the rollout and marks it archived. Archived files are intentionally excluded from ordinary active lookup. Current app-server resume rejects an archived thread and instructs the caller to run `codex unarchive <id>` first. See [resume rejection](https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/app-server/src/request_processors/thread_processor.rs#L3219-L3265).

Consequently, an archived rollout is preserved but not directly resumable in place. The supported path is:

```text
codex unarchive <uuid>
codex resume <uuid>
```

Unarchive reconstructs the active date tree from the timestamp embedded in the rollout filename. Preserving that filename is therefore load-bearing.

### What belongs in a faithful Codex archive

| Path | Relationship to session fidelity |
|---|---|
| `sessions/**/rollout-*.jsonl` | **Required payload** for active direct resume. |
| `archived_sessions/rollout-*.jsonl` | **Required payload** for archived history, but must be unarchived before resume. |
| `state_5.sqlite` plus `-wal`/`-shm` | Mutable index/state: rollout path, cwd, title, archive flag, timestamps, source, tokens, git metadata. Not required for active UUID fallback, but required for exact listing/archive/app state unless rebuilt. |
| `session_index.jsonl` | Thread-name index only. Not required for UUID resume. |
| `history.jsonl` | Input history (`session_id`, `text`, `ts`), not the transcript payload. |
| `shell_snapshots/<uuid>.<timestamp>.sh` | Shell environment snapshot. Current source cleans these after 3 days. Not required to find the rollout. |
| `config.toml`, `auth.json`, rules, plugins, memories | Client configuration and credentials, not one session's transcript. |
| `goals_1.sqlite`, `memories_1.sqlite`, `logs_2.sqlite`, process state | Feature-specific mutable state. Preserve only when the archive's scope includes those features, not for basic rollout resume. |
| `models_cache.json`, `.tmp/`, logs, version caches | Cache or installation state, not session-critical. |

### Retention

An exhaustive search of current Codex source and config found no age/count retention policy for rollout JSONL files and no automatic rollout deletion job. The only nearby timed cleanup found was 3-day shell-snapshot cleanup. Issue [#6015](https://github.com/openai/codex/issues/6015) remains an open request to add conversation retention. The accurate bounded conclusion is: **current source has no automatic rollout retention or deletion setting**. This is stronger than merely not seeing deletion locally, but it is not a promise that future releases will never add one.

## Constraints an archiver must satisfy

These are storage/resume constraints only, not recommendations for blotter's archive design.

1. **Preserve raw session bytes and filenames.** Both Claude and Codex treat the filename identity as meaningful. Renaming a UUID or rollout timestamp breaks lookup or unarchive reconstruction.
2. **Snapshot growing JSONL without inventing a new tail.** Both primary harnesses append while active. A captured prefix must remain byte-identical; a partial final line must be recognized as an in-flight snapshot, not normalized silently.
3. **Claude restore must recreate the encoded project directory used by lookup.** `claude --resume <id>` is scoped to the current project and worktrees. Restoring only `<uuid>.jsonl` under another project slug will not make direct ID lookup from the original cwd find it.
4. **Claude parent and same-UUID sidecars are one session-owned set.** Preserve `subagents/` and `tool-results/` with the parent. Preserve `file-history/<session>/` when checkpoint rewind fidelity is in scope.
5. **Claude capture must precede its startup retention deletion.** Current default is 30 days. A parent transcript and its sidecars can disappear permanently; historical bugs show that assuming the configured boundary is always honored has caused data loss.
6. **Codex active restore must land under `$CODEX_HOME/sessions/YYYY/MM/DD/` with a valid embedded matching ID.** Direct UUID fallback scans the active session tree, validates `session_meta.payload.id`, and can repair SQLite.
7. **Codex archived placement is a real state, not just organization.** A file left in `archived_sessions/` is rejected by resume. It must go through unarchive, which depends on the original timestamped filename, before it resumes normally.
8. **Codex names and list/archive fidelity require more than the rollout.** `session_index.jsonl` carries names; `state_5.sqlite` carries title, cwd, absolute rollout path, and archived state. UUID resume can recover without them, but the original picker/app state cannot.
9. **Mutable databases require a consistent snapshot.** Codex's SQLite files and opencode's `opencode.db` use WAL. Copying only the base DB while writes are outstanding can omit committed state. opencode has no per-session raw file substitute.
10. **Do not universalize cwd coupling.** Claude direct ID is project-scoped. Gemini normal discovery is project-slug scoped. Codex and pi accept direct IDs across cwd, although stored cwd still affects resumed context.
11. **Respect configurable roots and their layout semantics.** Claude can move all state with `CLAUDE_CONFIG_DIR`; Codex uses `CODEX_HOME`; opencode supports `OPENCODE_DB`; pi supports `--session-dir`/`PI_CODING_AGENT_SESSION_DIR`. Pi's override is an exact, flat session directory, not a replacement for the default `sessions/` parent that retains encoded-cwd children. Enumeration and restore must therefore handle both shapes. Hard-coding only default home paths, or assuming the default hierarchy survives an override, misses valid stores.
12. **Version the detector, not the user's data.** Claude declares its JSONL schema internal. Gemini has legacy layout migration; pi may rewrite old files on migration; opencode migrated from older file storage to SQLite. Structural recognition must tolerate known version families without rewriting archived raw bytes.

## Round-trip proof

On 2026-07-14, an environment-gated integration suite proved archive, source deletion, restore, and actual
context-bearing resume against Claude Code 2.1.209, Codex CLI 0.144.4, and pi 0.80.5. Every run used fresh
isolated roots and a disposable session containing only a random fictional codename.

- Claude resumed from the original cwd with only the restored main JSONL in its encoded project directory;
  no prior project index or history state was present.
- Codex restored an archived rollout into a new `CODEX_HOME`, discovered and unarchived it without
  `state_5.sqlite`, then resumed it by UUID.
- Pi restored a version 1 session from a flat `PI_CODING_AGENT_SESSION_DIR`, resumed it by UUID, and migrated
  only the live file to version 3. Forking that migrated session created a separate version 3 file with inherited
  context and a `parentSession` reference to the restored path. The compressed archive remained byte-identical.

The executable proof is `apps/cli/test/resume-proof.test.ts` and runs when `BLOTTER_RESUME_PROOF=1`.

## Open questions and settling experiments

1. **Claude in-place rewrite edge cases.** Ordinary writes appear append-oriented, but closed source leaves rename, `/compact`, `/rename`, `/branch`, crash recovery, and `/cd` implementation details unverified. Settle by recording inode, size, prefix hash, and path before and after each operation in a disposable session containing no private content.
2. **Claude lossy-slug collisions.** Docs define non-alphanumeric replacement but not conflict handling when two absolute paths encode identically. Settle with two disposable cwd paths differing only by punctuation, then inspect whether sessions share a directory and whether picker filtering separates them by in-file `cwd`.
3. **Claude retention age basis and sweep cadence.** Current docs say “older than” the cutoff at startup but do not identify mtime, birth time, last record timestamp, or a throttling interval behind `.last-cleanup`. The installed binary exposes the setting and marker strings but not enough readable implementation to establish the comparison safely. Settle with disposable files whose mtime, birth time, and last-record timestamp straddle the cutoff independently, then launch once before and once after changing `.last-cleanup`.
4. **Codex target machine with missing stored cwd.** Direct UUID is not cwd-filtered, but interactive resume defaults to the stored cwd. Settle by copying one non-sensitive rollout to a fresh machine/config root where that cwd does not exist, then test `codex resume <uuid> -C <existing-dir>` and `codex exec resume` without a prompt.
5. **Cursor's entire persistence contract.** Official sources do not disclose local store path, format, mutation, retention, or index behavior. Settle by installing Cursor CLI in an isolated home, creating one disposable session, observing filesystem changes, restarting, resuming by ID and folder, and checking whether logout or machine transfer changes discovery.
6. **Gemini slug-map portability.** Current source ties discovery to an absolute-path mapping in `projects.json`; it is unclear whether copying the map to another absolute root can be repaired without importing and changing identity. Settle with a disposable store moved to a second home/path, testing UUID resume before and after recreating the map.
7. **opencode exact-ID portability across project/database context.** Source performs exact ID lookup, but public docs do not guarantee cross-project resume or DB portability. Settle with a consistent copy of `opencode.db` plus WAL/SHM into a fresh XDG data root, then run `opencode -s <id>` from a different cwd with networking disabled.
