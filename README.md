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
pnpm add github:DaneelOlivaw1/dsh-everos-memory#v0.1.0
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
