/**
 * Tests for dsh-everos-memory. No network, no DSH runtime: a fake Cordis
 * context and a stubbed fetch are enough, because the plugin's whole job is
 * "decide when to POST what".
 *
 *   node test.mjs
 */
import assert from 'node:assert/strict'
import { apply, messageText, clampText, toMemoryMessage, projectIdFromCwd } from './index.mjs'

const config = {
  enabled: true,
  baseUrl: 'https://memory.test',
  apiKey: 'tok',
  userId: 'daneel',
  appId: 'default',
  projectId: 'default',
  idleSeconds: 5,
  minMessages: 2,
  maxCharsPerMessage: 4000,
  flushOnDispose: true,
  excludeSessions: ['subagent'],
  recall: false,
}

/** Minimal Cordis context: records listeners, runs injected callbacks. */
function fakeContext(cp = {}) {
  const listeners = new Map()
  const commands = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
    },
    inject(_deps, callback) {
      callback({ commands: { register: (definition) => commands.push(definition) } })
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    commands,
    agents: { get: () => cp.agent ?? null },
  }
  return ctx
}

const userEvent = (text, at = 1_700_000_000_000) => ({
  type: 'user/message',
  createdAt: at,
  data: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantEvent = (text, at = 1_700_000_001_000) => ({
  type: 'assistant/message',
  createdAt: at,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('messageText reads text blocks and ignores tool blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: ' hello ' }] }), 'hello')
  assert.equal(
    messageText({ content: [{ type: 'tool-call', name: 'x' }, { type: 'text', text: 'kept' }] }),
    'kept',
  )
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText(undefined), '')
})

test('clampText truncates and survives a missing cap', () => {
  assert.equal(clampText('abcdef', 3), 'abc…')
  assert.equal(clampText('abc', 10), 'abc')
  assert.equal(clampText('abc', 0), 'abc')
})

test('toMemoryMessage keeps text, drops tool-only assistant turns', () => {
  assert.deepEqual(toMemoryMessage(userEvent('hi'), config), {
    sender_id: 'daneel',
    role: 'user',
    timestamp: 1_700_000_000_000,
    content: 'hi',
  })
  const toolOnly = { type: 'assistant/message', createdAt: 1, data: { message: { content: [{ type: 'tool-call' }] } } }
  assert.equal(toMemoryMessage(toolOnly, config), null)
  assert.equal(toMemoryMessage({ type: 'tool/result', createdAt: 1, data: {} }, config), null)
})

test('flush posts add + flush and clears the buffer', async () => {
  const ctx = fakeContext()
  apply(ctx, config)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ data: { status: 'accumulated' } }) }
  }

  ctx.emit('session/event', { id: 's1' }, userEvent('我的部署代号是 Blue Heron'))
  ctx.emit('session/event', { id: 's1' }, assistantEvent('记下了'))
  const definition = ctx.commands.find((command) => command.name === 'everos')
  const outcome = await definition.handler({ sessionId: 's1', rawInput: 'flush' })
  assert.equal(outcome, 'EverOS: flushed')

  assert.equal(calls.length, 2, 'add then flush')
  assert.equal(calls[0].url, 'https://memory.test/api/v2/memory/add')
  assert.equal(calls[0].body.session_id, 's1')
  assert.equal(calls[0].body.messages.length, 2)
  assert.equal(calls[0].body.messages[0].role, 'user')
  assert.equal(calls[1].url, 'https://memory.test/api/v2/memory/flush')

  // A second flush has nothing left to send.
  const again = await definition.handler({ sessionId: 's1', rawInput: 'flush' })
  assert.equal(again, 'EverOS: empty（这个会话可写入的内容为空）'.replace('可写入的内容为空', '还没有可写入的内容'))
  assert.equal(calls.length, 2)
})

test('a failed add keeps the buffer for the next attempt', async () => {
  const ctx = fakeContext()
  apply(ctx, config)
  let fail = true
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url) })
    if (fail) return { ok: false, status: 503, text: async () => 'down' }
    return { ok: true, json: async () => ({ data: { status: 'extracted' } }) }
  }

  ctx.emit('session/event', { id: 's2' }, userEvent('第一句'))
  ctx.emit('session/event', { id: 's2' }, assistantEvent('第二句'))
  const definition = ctx.commands.find((command) => command.name === 'everos')
  assert.equal(await definition.handler({ sessionId: 's2', rawInput: 'flush' }), 'EverOS: failed')
  assert.equal(calls.length, 1, 'flush endpoint not called after a failed add')

  fail = false
  assert.equal(await definition.handler({ sessionId: 's2', rawInput: 'flush' }), 'EverOS: flushed')
  assert.equal(calls.length, 3, 'buffer survived the failure: one retried add, then flush')
})

test('idle timer fires after the quiet window', async () => {
  const ctx = fakeContext()
  apply(ctx, { ...config, idleSeconds: 5 })
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ data: { status: 'extracted' } }) }
  }
  ctx.emit('session/event', { id: 's3' }, userEvent('一句话'))
  ctx.emit('session/event', { id: 's3' }, assistantEvent('回一句'))
  assert.equal(calls.length, 0, 'nothing sent immediately')
  await new Promise((resolve) => setTimeout(resolve, 5_400))
  assert.equal(calls.length >= 1, true, 'idle flush ran')
})

test('volatile refs ({} / get()) are unwrapped like plain values', async () => {
  const ctx = fakeContext()
  const refConfig = {
    ...config,
    baseUrl: { get: () => 'https://memory.test' },
    apiKey: { get: () => 'tok' },
    userId: { get: () => 'daneel' },
    idleSeconds: { get: () => 5 },
    excludeSessions: { get: () => [] },
  }
  apply(ctx, refConfig)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization })
    return { ok: true, json: async () => ({ data: { status: 'extracted' } }) }
  }
  ctx.emit('session/event', { id: 's5' }, userEvent('ref 配置也能跑'))
  ctx.emit('session/event', { id: 's5' }, assistantEvent('是的'))
  const definition = ctx.commands.find((command) => command.name === 'everos')
  assert.equal(await definition.handler({ sessionId: 's5', rawInput: 'flush' }), 'EverOS: flushed')
  assert.equal(calls[0].url, 'https://memory.test/api/v2/memory/add')
  assert.equal(calls[0].auth, 'Bearer tok')
})

test('recall injects high-score hits as a delimited notice', async () => {
  const steered = []
  const ctx = fakeContext({ agent: { steer: (m) => steered.push(m) } })
  apply(ctx, { ...config, recall: true, recallMinScore: 0.3 })
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/search')
      ? { data: { episodes: [
          { id: 'daneel_ep_1', score: 0.55, summary: '用户偏好 Postgres 17' },
          { id: 'daneel_ep_2', score: 0.05, summary: '无关旧事' },
        ] } }
      : { data: { status: 'extracted' } }),
  })
  ctx.emit('session/event', { id: 'r1' }, userEvent('我用什么数据库来着'))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(steered.length, 1)
  const text = steered[0].content[0].text
  assert.match(text, /BEGIN STORED MEMORY/)
  assert.match(text, /Postgres 17/)
  assert.doesNotMatch(text, /无关旧事/, 'below the score floor')
  assert.equal(steered[0].source.kind, 'everos-memory')
})

test('a failing recall never throws and never blocks the turn', async () => {
  const steered = []
  const ctx = fakeContext({ agent: { steer: (m) => steered.push(m) } })
  apply(ctx, { ...config, recall: true, recallTimeoutMs: 300 })
  globalThis.fetch = async () => { throw new Error('network down') }
  ctx.emit('session/event', { id: 'r2' }, userEvent('这一句会触发检索'))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(steered.length, 0)
})

test('project id derives from cwd and stays inside the ScopeId charset', () => {
  assert.equal(projectIdFromCwd('/Users/d/project/everos-memory-deploy'), 'everos-memory-deploy')
  assert.equal(projectIdFromCwd('/tmp/My Project!'), 'my-project')
  assert.equal(projectIdFromCwd('/tmp/..'), 'default')
  assert.equal(projectIdFromCwd('/tmp/__weird__name'), '__weird__name')
  assert.equal(projectIdFromCwd('', 'fallback'), 'fallback')
  assert.equal(projectIdFromCwd(undefined, 'fallback'), 'fallback')
  assert.match(projectIdFromCwd('/x/' + 'a'.repeat(120)), /^[a-z0-9_.-]{1,64}$/)
})

test('recall searches the project scope and the fallback, without duplicates', async () => {
  const steered = []
  const ctx = fakeContext({ agent: { steer: (m) => steered.push(m) } })
  apply(ctx, { ...config, recall: true, recallMinScore: 0.1, projectId: 'default' })
  const searches = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    searches.push(body.project_id)
    const hits = body.project_id === 'alpha'
      ? [{ id: 'proj_1', score: 0.6, summary: 'alpha 项目的构建命令是 pnpm build' }]
      : [{ id: 'proj_1', score: 0.5, summary: 'alpha 项目的构建命令是 pnpm build' },
         { id: 'glob_1', score: 0.2, summary: '用户偏好 vim 键位' }]
    return { ok: true, json: async () => ({ data: { episodes: hits } }) }
  }
  ctx.emit('session/event', { id: 'scoped', header: { cwd: '/Users/d/project/alpha' } }, userEvent('这个项目怎么构建'))
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(searches, ['alpha', 'default'], 'project scope first, then fallback')
  assert.equal(steered.length, 1)
  const text = steered[0].content[0].text
  assert.equal((text.match(/proj_1/g) ?? []).length, 1, 'deduped across scopes')
  assert.match(text, /vim 键位/, 'fallback memory still reachable')
})

test('excluded and empty-base sessions are ignored', async () => {
  const ctx = fakeContext()
  apply(ctx, { ...config, baseUrl: '' })
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({}) }
  }
  ctx.emit('session/event', { id: 'subagent-1' }, userEvent('x'))
  ctx.emit('session/event', { id: 's4' }, userEvent('y'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(calls.length, 0)
})

let failed = 0
for (const [label, fn] of tests) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}\n     ${error instanceof Error ? error.message : error}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed === 0 ? 0 : 1)
