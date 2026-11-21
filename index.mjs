/**
 * dsh-everos-memory — idle-triggered memory capture for DSH.
 *
 * The problem this solves: the EverOS MCP server *can* save memory
 * (`add_memory` internally does add + flush, so one call is enough), but the
 * model only calls it when it feels like it — usually never. So the store stays
 * empty and "memory" is a feature you configure and then forget about.
 *
 * Hermes solves the same problem in its host process: after a turn it queues a
 * background self-improvement review, and on a busy local runtime it *defers
 * that review until the machine has been quiet for a settle window*. Judgement
 * stays with the model; the *timing* is the host's job.
 *
 * This plugin does the timing half for DSH:
 *
 *   1. watch `session/event` for user/assistant messages, buffer them per session;
 *   2. when a session has been quiet for `idleSeconds`, POST the buffered
 *      exchange to EverOS `/api/v2/memory/add` and then `/flush`;
 *   3. also flush when the session is disposed, so a short session is not lost.
 *
 * Nothing here calls a model. The extraction, summarisation and embedding all
 * happen on the EverOS side; this plugin only decides *when* to hand the
 * transcript over.
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'everos-memory'

/** Services this plugin needs. */
export const inject = ['sessions']

export const Config = z.object({
  /** Master switch. Off leaves every buffer untouched. */
  enabled: z.boolean().default(true).volatile(),
  /** EverOS base URL, no trailing slash, e.g. https://memory.mergio.app */
  baseUrl: z.string().default('').volatile(),
  /** Gateway token (EverOS itself has no auth; the gateway does). */
  apiKey: z.string().default('').volatile(),
  /** Memory owner on the EverOS side. */
  userId: z.string().default('default-user').volatile(),
  /** Business scope. */
  appId: z.string().default('default').volatile(),
  /** Business scope. */
  projectId: z.string().default('default').volatile(),
  /** Quiet window before a buffered exchange is written. */
  idleSeconds: z.number().step(1).min(5).default(300).volatile(),
  /** Minimum buffered messages before an idle flush is worth an LLM call. */
  minMessages: z.number().step(1).min(1).default(2).volatile(),
  /** Per-message character cap; long tool dumps are truncated. */
  maxCharsPerMessage: z.number().step(100).min(200).default(4000).volatile(),
  /** Flush pending buffers when a session is disposed. */
  flushOnDispose: z.boolean().default(true).volatile(),
  /** Session-id substrings to ignore, e.g. ["subagent", "monitor"]. */
  excludeSessions: z.array(z.string()).default([]).volatile(),
})

/**
 * Read one config field.
 *
 * Fields declared `.volatile()` arrive as a reference object with `get()`, not
 * as the plain value (`JSON.stringify` renders them as `{}`). Everything this
 * plugin reads goes through here so both shapes work.
 */
export function read(field, fallback) {
  const value = typeof field?.get === 'function' ? field.get() : field
  return value ?? fallback
}

/** Pull plain text out of an LLM message, ignoring tool blocks. */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Cut a message to the configured cap without splitting a surrogate pair. */
export function clampText(text, max) {
  if (!max || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * Turn one session event into an EverOS message, or null when it carries no text.
 *
 * @param event - a `SessionEvent` from the log.
 * @param config - plugin config (sender ids and caps).
 * @returns the `messages[]` item EverOS accepts, or null.
 */
export function toMemoryMessage(event, config) {
  const type = event?.type
  const timestamp = Number.isFinite(event?.createdAt) ? event.createdAt : Date.now()
  const cap = read(config.maxCharsPerMessage, 4000)
  const userId = read(config.userId, 'default-user')
  if (type === 'user/message') {
    const content = clampText(messageText(event.data), cap)
    if (!content) return null
    return { sender_id: userId, role: 'user', timestamp, content }
  }
  if (type === 'assistant/message') {
    const content = clampText(messageText(event.data?.message), cap)
    if (!content) return null
    return { sender_id: read(config.assistantSenderId, `${userId}-agent`), role: 'assistant', timestamp, content }
  }
  return null
}

export function apply(ctx, config) {
  /** sessionId -> { messages, timer, busy } */
  const sessions = new Map()
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`everos-memory: ${message}`)
    } catch {
      /* logging must never break capture */
    }
  }


  const excluded = (id) => (c.excludeSessions ?? []).some((needle) => needle && id.includes(needle))

  /** Live view of the config fields; volatile refs are unwrapped on each read. */
  const c = {
    get enabled() { return read(config.enabled, true) },
    get baseUrl() { return read(config.baseUrl, '') },
    get apiKey() { return read(config.apiKey, '') },
    get userId() { return read(config.userId, 'default-user') },
    get appId() { return read(config.appId, 'default') },
    get projectId() { return read(config.projectId, 'default') },
    get idleSeconds() { return Number(read(config.idleSeconds, 300)) },
    get minMessages() { return Number(read(config.minMessages, 2)) },
    get flushOnDispose() { return read(config.flushOnDispose, true) },
    get excludeSessions() { return read(config.excludeSessions, []) ?? [] },
  }

  const base = () => String(c.baseUrl || process.env.EVEROS_BASE_URL || '').replace(/\/+$/, '')
  const token = () => String(c.apiKey || process.env.EVEROS_API_KEY || '')

  log('info', `ready — endpoint=${base() || '(unset)'} scope=${c.userId}/${c.appId}/${c.projectId} idle=${c.idleSeconds}s`)

  async function post(path, body) {
    const response = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${path} -> HTTP ${response.status} ${detail.slice(0, 300)}`)
    }
    return response.json().catch(() => ({}))
  }

  /** Hand one session's buffer to EverOS. Keeps the buffer on failure. */
  async function flush(sessionId, reason) {
    const entry = sessions.get(sessionId)
    if (entry === undefined || entry.busy) return 'busy'
    if (entry.messages.length === 0) return 'empty'
    if (reason === 'idle' && entry.messages.length < c.minMessages) return 'buffering'
    if (!base()) {
      log('warn', 'baseUrl is empty; skipping flush')
      return 'unconfigured'
    }

    entry.busy = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    const batch = entry.messages.slice()
    const scope = { session_id: sessionId, app_id: c.appId, project_id: c.projectId }
    try {
      const added = await post('/api/v2/memory/add', { ...scope, messages: batch })
      const status = added?.data?.status ?? added?.status
      if (status === 'accumulated') {
        await post('/api/v2/memory/flush', scope)
      }
      entry.messages = entry.messages.slice(batch.length)
      log('info', `flushed ${batch.length} message(s) from ${sessionId} (${reason})`)
      return 'flushed'
    } catch (error) {
      log('warn', `flush failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    } finally {
      entry.busy = false
    }
  }

  function schedule(sessionId) {
    const entry = sessions.get(sessionId)
    if (entry === undefined) return
    if (entry.timer) clearTimeout(entry.timer)
    const timer = setTimeout(() => {
      entry.timer = undefined
      void flush(sessionId, 'idle')
    }, Math.max(5, c.idleSeconds) * 1000)
    timer.unref?.()
    entry.timer = timer
  }

  ctx.on('session/event', (session, event) => {
    if (!c.enabled || !base()) return
    const sessionId = String(session?.id ?? '')
    if (!sessionId || excluded(sessionId)) return
    const message = toMemoryMessage(event, config)
    if (message === null) return

    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { messages: [], timer: undefined, busy: false }
      sessions.set(sessionId, entry)
    }
    entry.messages.push(message)
    schedule(sessionId)
  })

  ctx.on('session/disposed', (session) => {
    if (!c.enabled || !c.flushOnDispose) return
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return
    void flush(sessionId, 'dispose').finally(() => {
      const entry = sessions.get(sessionId)
      if (entry && entry.messages.length === 0) sessions.delete(sessionId)
    })
  })

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      definitionId: 'dsh-everos-memory/everos',
      name: 'everos',
      description: 'Show or force this session\'s EverOS memory capture (status | flush)',
      input: { hint: '[status|flush]' },
      handler: async (invocation) => {
        const sessionId = String(invocation?.agent?.session?.id ?? invocation?.sessionId ?? '')
        const verb = String(invocation?.rawInput ?? '').trim().split(/\s+/)[0] || 'status'
        if (verb === 'flush') {
          const result = await flush(sessionId, 'manual')
          return `EverOS: ${result}${result === 'empty' ? '（这个会话还没有可写入的内容）' : ''}`
        }
        const entry = sessions.get(sessionId)
        return [
          `EverOS 记忆捕获 · ${c.enabled ? '开启' : '关闭'}`,
          `- 端点：${base() || '(未配置 baseUrl)'}`,
          `- 归属：${c.userId} / ${c.appId} / ${c.projectId}`,
          `- 空闲窗口：${c.idleSeconds}s，最少 ${c.minMessages} 条`,
          `- 当前缓冲：${entry?.messages.length ?? 0} 条`,
        ].join('\n')
      },
    })
  })

  ctx.on('dispose', () => {
    for (const entry of sessions.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
  })
}
