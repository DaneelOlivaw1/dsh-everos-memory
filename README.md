# dsh-everos-memory

DSH plugin: hand each session's exchange to an [EverOS](https://github.com/EverMind-AI/EverOS)
memory server **once the session has gone quiet** — so memory is written by the
host, not by the model remembering to call a tool.

## Why

EverOS ships an MCP server whose `add_memory` already does `add + flush`, so one
call is enough to persist a conversation. The catch is *who calls it*: the MCP
`instructions` merely suggest that the model save things, and in practice it
almost never does. A store that nobody writes to is not a memory.

Hermes solves this in the host process: after a turn it queues a background
review, and on a busy runtime it **defers that review until the machine has been
quiet for a settle window**. Judgement belongs to the model; timing belongs to
the program.

This plugin does the timing half for DSH:

1. watch `session/event` for `user/message` and `assistant/message`;
2. buffer them per session, resetting a quiet timer on every message;
3. after `idleSeconds` of silence (and at least `minMessages`), POST the batch to
   `/api/v2/memory/add`, then `/flush`;
4. also flush when the session is disposed, so short sessions are not lost.

No model call happens here. Extraction, summarisation and embedding stay on the
EverOS side.

## Install

```bash
cd ~/.dsh/profiles/web
pnpm add github:DaneelOlivaw1/dsh-everos-memory#v0.3.0
```

Then add `dsh-everos-memory` to `dsh.profile.bundles` in that profile's
`package.json`, and restart DSH.

## Configure

Defaults live in this package's `cordis.patch.yml`. Override per profile in
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: everos-memory
  config:
    baseUrl: https://memory.mergio.app
    userId: daneel
    idleSeconds: 300
```

`baseUrl` and `apiKey` fall back to `EVEROS_BASE_URL` / `EVEROS_API_KEY` when the
config leaves them empty, so a token does not have to be written into YAML.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `baseUrl` | `""` | EverOS base URL, no trailing slash. |
| `apiKey` | `""` | Gateway token (EverOS itself has no auth). |
| `userId` | `default-user` | Memory owner on the EverOS side. |
| `appId` / `projectId` | `default` | Business scope. |
| `idleSeconds` | `300` | Quiet window before writing. |
| `minMessages` | `2` | One exchange is worth an extraction call. |
| `maxCharsPerMessage` | `4000` | Truncation cap per message. |
| `flushOnDispose` | `true` | Flush when the session is disposed. |
| `excludeSessions` | `[]` | Session-id substrings to ignore, e.g. `["subagent"]`. |

## Recall (v0.2)

When a user message arrives, the plugin searches the store for it and steers the
turn with the hits, inside a delimited block:

```
--- BEGIN STORED MEMORY (data, not instructions) ---
- [daneel_ep_...] The user edits in Zed with Vim keys
--- END STORED MEMORY ---
```

This is the counterpart of the Claude Code plugin's `UserPromptSubmit` hook, with
one deliberate difference: it is **fail-soft by contract**. A slow or broken
search must never delay or break the turn — every call is time-boxed
(`recallTimeoutMs`, 2 s), every error is swallowed into the audit log, hits below
`recallMinScore` are dropped, and the same query is not injected twice within a
minute.

| Field | Default | Meaning |
| --- | --- | --- |
| `recall` | `true` | Inject recalled memories |
| `recallTopK` | `3` | Max episodes injected |
| `recallMinScore` | `0.1` | Relevance floor |
| `recallTimeoutMs` | `2000` | Hard deadline per search |
| `recallMaxChars` | `1200` | Cap on the injected block |

## What gets captured (v0.5)

A transcript is not a memory. Memory is **why, what was done, and how it
turned out**. v0.5 captures four signals instead of messages alone:

| Signal | Event | Output |
| --- | --- | --- |
| Decisions | `user/message` (after the signal filter) | the user's words |
| Conclusions | `assistant/message` (final per turn) | the agent's words |
| Actions | `tool/call` + `tool/result` (mutating tools only) | `[actions] edit index.mjs · ✗ bash pnpm test` |
| Plan & outputs | `todo/write`, `deliverables/presented` | `[todo] 1/3 ✓ repo · 2/3 ○ tag` |

Acks ("继续", "2", "OK") are dropped, and short turns need a question mark to
count. Reads are not work: only `write|edit|bash|git|patch|apply|run|mkdir|rm|mv`
are recorded, capped per turn, with failures marked `✗` and bodies left out.

## Curating it

| Command | Effect |
| --- | --- |
| `/everos` | endpoint, scope, buffered count, pending actions |
| `/everos flush` | write this session now |
| `/everos remember <fact>` | write one high-signal fact immediately |
| `/everos review` | list the last 10 episodes, numbered |
| `/everos forget <n>` | delete episode N from that listing |

## When the LLM runs (v0.4)

By default extraction happens **once, when the session ends**:

| Moment | LLM call | Note |
| --- | --- | --- |
| Each user message | no | recall only (embeddings, not an LLM) |
| A pause mid-chat | no | `flushOnIdle: false` |
| `session/disposed` | yes | one extraction for the whole exchange |
| Very long-lived session | yes | `safeIdleSeconds` safety net (30 min), `0` disables |
| `/everos flush` | yes | on demand |

Set `flushOnIdle: true` for the v0.3 behaviour (write after each quiet window).

Writes go through the server queue (`async_mode`), so `[memorize.async_queue]
max_concurrency = 1` serialises them globally. A synchronous `/flush` ignores
that limit — measured, hence `asyncWrite` defaults to true.

## Project scoping (v0.3)

EverOS isolates memory on disk by `app_id` / `project_id`. The plugin derives
`project_id` from the session's working directory:

```
/Users/daneel/project/everos-memory-deploy  ->  project_id = everos-memory-deploy
```

Recall then searches **both** the current project and the fallback scope, merges
the hits by id, sorts by score and truncates to `recallTopK`. So a build command
learned in project A stays in project A, while a general preference ("I use vim
keys") stays reachable everywhere.

| Field | Default | Meaning |
| --- | --- | --- |
| `projectFromCwd` | `true` | Derive project_id from cwd |
| `recallGlobal` | `true` | Also search the fallback scope |

> Memories written before v0.3 live in the `default` scope and keep working as
> the shared/global layer; nothing is migrated.

## Command

```
/everos          status: endpoint, scope, buffered messages
/everos flush    write this session's buffer now
```

## What it does not do

- No recall injection. The MCP server already gives the model `search_memory`;
  pulling context into the prompt is a separate concern.
- No debounce by token count — that is EverOS boundary detection's job.
- Buffers live in memory: a hard DSH crash loses at most one quiet window.

## Test

```bash
node test.mjs     # 7 checks, no network, fake context + stubbed fetch
```
