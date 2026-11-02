/**
 * dsh-model-auto-retry 的单元测试（零依赖，`node --test` 直接跑）。
 *
 * 没有 dsh 运行时，所以用一个最小假 ctx 复刻插件真正依赖的三件事：
 *   - `ctx.on(name, handler)`：事件总线（waterfall 与 emit 两种派发）
 *   - `ctx.effect(factory)`：卸载钩子（factory() 返回清理函数）
 *   - `ctx.logger` / `ctx.agents`：日志与存活查询
 *
 * 测试目标是**决策与状态机**，不是真实模型调用；真实链路验证见 README 的「验证」章节。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/* ------------------------------------------------------------------------- *
 * 测试脚手架
 * ------------------------------------------------------------------------- */

/**
 * 建一个假 Cordis 上下文并激活插件。
 *
 * @param {object} [config] - 插件 config。
 * @param {{agents?: Map<string, object>}} [options] - 预置的 Agent 注册表。
 * @returns {object} 可直接驱动的 harness。
 */
function createHarness(config = {}, options = {}) {
  const agents = options.agents ?? new Map()
  const handlers = new Map()
  const logs = []
  const cleanups = []

  const push = (level) => (...args) => { logs.push([level, args.join(' ')]) }

  const ctx = {
    logger: { info: push('info'), warn: push('warn'), debug: push('debug') },
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      // 与 Cordis 一致：返回的 disposer 只移除这一个监听。
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(factory) {
      cleanups.push(factory())
      return () => {}
    },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      isOwnedBy: () => false,
    },
    get: () => undefined,
  }

  apply(ctx, config)

  return {
    ctx,
    agents,
    handlers,
    logs,
    /**
     * 按注册顺序派发一个 waterfall 事件。
     * @param {string} name - 事件名。
     * @param {object} payload - 载荷。
     * @param {() => Promise<unknown>} [terminal] - 链路末端的默认决策。
     * @returns {Promise<unknown>} 最终决策。
     */
    async waterfall(name, payload, terminal = async () => undefined) {
      const list = handlers.get(name) ?? []
      let index = 0
      const next = async () => (index < list.length ? list[index++](payload, next) : terminal())
      return next()
    },
    /**
     * 按注册顺序同步派发一个 emit 事件（支持多参数，例如 `session/event(session, event)`）。
     * @param {string} name - 事件名。
     * @param {...unknown} args - 事件参数。
     */
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    /** 执行插件的卸载钩子（等价于 profile 热重载/停用插件）。 */
    async dispose() {
      for (const cleanup of cleanups) await cleanup()
    },
  }
}

/**
 * 造一个够插件用的假 Agent。
 * @param {string} id - Agent/Session id。
 * @returns {{agent: object, followed: object[]}} Agent 与它收到的 followup 消息。
 */
function makeAgent(id = 'session-test') {
  const followed = []
  const agent = {
    id,
    session: { id },
    status: 'idle',
    inbox: { hasPending: false },
    followup(message) { followed.push(message) },
  }
  return { agent, followed }
}

/**
 * 一个被测 Agent 的 AbortSignal。
 * @returns {AbortSignal} 未取消的信号。
 */
function liveSignal() {
  return new AbortController().signal
}

/**
 * 实测得到的限流失败形状（pi-ai / OpenAI 兼容适配器：只有 code + message，没有 status）。
 * @returns {{message: string, code: string}} LlmFailure。
 */
function rateLimitedFailure() {
  return {
    message: '429: {"message":"rps exhausted","type":"quota_exceeded_error","code":"8"}',
    code: 'RATE_LIMIT',
  }
}

/**
 * 造一个 `agent/request-error` 载荷。
 * @param {object} agent - 目标 Agent。
 * @param {object} [failure] - 失败对象。
 * @param {AbortSignal} [signal] - turn 的取消信号。
 * @returns {object} 载荷。
 */
function requestErrorPayload(agent, failure = rateLimitedFailure(), signal = liveSignal()) {
  return { agent, turn: 1, step: 1, provider: 'mock', failure, retryPolicy: undefined, signal }
}

/* ------------------------------------------------------------------------- *
 * 配置校验
 * ------------------------------------------------------------------------- */

test('未知配置键在激活期直接报错（避免"装了但没生效"）', () => {
  assert.throws(() => createHarness({ maxRetry: 3 }), /unknown config key "maxRetry"/)
})

test('非法枚举值被拒绝', () => {
  assert.throws(() => createHarness({ mode: 'sometimes' }), /mode.*must be one of/)
})

test('initialDelayMs 大于 maxDelayMs 被拒绝', () => {
  assert.throws(
    () => createHarness({ initialDelayMs: 9000, maxDelayMs: 1000 }),
    /initialDelayMs.*<= maxDelayMs/,
  )
})

test('非法正则在激活期报错', () => {
  assert.throws(() => createHarness({ messagePattern: '([' }), /messagePattern.*regular expression/)
})

test('rateLimitStatuses 同时接受 number 与数字字符串两种写法', async () => {
  for (const statuses of [[429], ['429']]) {
    const { agent } = makeAgent()
    const harness = createHarness({ rateLimitStatuses: statuses, initialDelayMs: 1 })
    const decision = await harness.waterfall(
      'agent/request-error',
      requestErrorPayload(agent, { message: 'too many requests', code: 'X', status: 429 }),
    )
    assert.deepEqual(decision, { kind: 'retry' }, `写法 ${JSON.stringify(statuses)} 应可用`)
  }
})

test('非法的 rateLimitStatuses 在激活期报错', () => {
  assert.throws(() => createHarness({ rateLimitStatuses: ['abc'] }), /rateLimitStatuses/)
})

test('缺省配置可激活，且只注册 hybrid 需要的监听', () => {
  const harness = createHarness()
  assert.deepEqual(
    [...harness.handlers.keys()].sort(),
    ['agent/disposed', 'agent/request-error', 'agent/status', 'session/event'],
  )
})

test("mode: 'off' 不注册任何监听", () => {
  const harness = createHarness({ mode: 'off' })
  assert.equal(harness.handlers.size, 0)
  assert.match(harness.logs[0][1], /mode=off/)
})

test("mode: 'continue' 只注册续跑所需的监听", () => {
  const harness = createHarness({ mode: 'continue' })
  assert.deepEqual(
    [...harness.handlers.keys()].sort(),
    ['agent/disposed', 'agent/status', 'session/event'],
  )
})

/* ------------------------------------------------------------------------- *
 * 第一层：请求期接管
 * ------------------------------------------------------------------------- */

test('下游已经重试时原样透传，不计数也不等待', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1 })
  const decision = await harness.waterfall(
    'agent/request-error',
    requestErrorPayload(agent),
    async () => ({ kind: 'retry' }),
  )
  assert.deepEqual(decision, { kind: 'retry' })
  // 没有我们自己打的接管日志 = 没走接管分支。
  assert.equal(harness.logs.some(([, line]) => line.includes('原地重试')), false)
})

test('内置重试放弃后，429 由我们接手（code = RATE_LIMIT）', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1 })
  const decision = await harness.waterfall('agent/request-error', requestErrorPayload(agent))
  assert.deepEqual(decision, { kind: 'retry' })
  assert.match(harness.logs.map(([, line]) => line).join('\n'), /第 1\/6 次原地重试/)
})

test('只有 status=429、没有 code 时也能识别', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1 })
  const decision = await harness.waterfall(
    'agent/request-error',
    requestErrorPayload(agent, { message: 'too many requests', code: 'SOMETHING', status: 429 }),
  )
  assert.deepEqual(decision, { kind: 'retry' })
})

test('只有 429 文本、没有 code/status 时靠 messagePattern 兜底', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1 })
  const decision = await harness.waterfall(
    'agent/request-error',
    requestErrorPayload(agent, { message: '429: rps exhausted', code: '' }),
  )
  assert.deepEqual(decision, { kind: 'retry' })
})

test('配额/鉴权类失败不重试（重试也不会变好）', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1 })
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL']) {
    const decision = await harness.waterfall(
      'agent/request-error',
      requestErrorPayload(agent, { message: 'nope', code, status: 429 }),
    )
    assert.equal(decision, undefined, `${code} 不应被自动重试`)
  }
  assert.equal(harness.logs.some(([, line]) => line.includes('原地重试')), false)
})

test('非限流失败保持原逻辑（放行给宿主）', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1 })
  const decision = await harness.waterfall(
    'agent/request-error',
    requestErrorPayload(agent, { message: 'boom', code: 'SERVER' }),
  )
  assert.equal(decision, undefined)
})

test('达到 maxInLoopRetries 后放行，交给续跑层', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1, maxInLoopRetries: 2 })
  const decisions = []
  for (let i = 0; i < 3; i += 1) {
    decisions.push(await harness.waterfall('agent/request-error', requestErrorPayload(agent)))
  }
  assert.deepEqual(decisions, [{ kind: 'retry' }, { kind: 'retry' }, undefined])
  assert.match(harness.logs.map(([, line]) => line).join('\n'), /已达 maxInLoopRetries=2/)
})

test('换了 step 之后计数归零（预算是按 step 的，不是按会话的）', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 1, maxInLoopRetries: 1 })
  const first = await harness.waterfall('agent/request-error', requestErrorPayload(agent))
  const second = await harness.waterfall(
    'agent/request-error',
    { ...requestErrorPayload(agent), step: 2 },
  )
  assert.deepEqual([first, second], [{ kind: 'retry' }, { kind: 'retry' }])
})

test('turn 已取消时不等待、直接放行', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 5000 })
  const controller = new AbortController()
  controller.abort(new Error('user stop'))
  const started = Date.now()
  const decision = await harness.waterfall(
    'agent/request-error',
    requestErrorPayload(agent, rateLimitedFailure(), controller.signal),
  )
  assert.equal(decision, undefined)
  assert.ok(Date.now() - started < 1000, '取消后应立即返回')
})

test('插件卸载会打断进行中的等待，不留悬挂 Promise', async () => {
  const { agent } = makeAgent()
  const harness = createHarness({ initialDelayMs: 10000 })
  const pending = harness.waterfall('agent/request-error', requestErrorPayload(agent))

  // 让 handler 真正进入 sleep 分支。
  await new Promise((resolve) => setTimeout(resolve, 20))
  const started = Date.now()
  await harness.dispose()
  assert.equal(await pending, undefined)
  assert.ok(Date.now() - started < 2000, '卸载后等待应被 abort 立即结束')
})

/* ------------------------------------------------------------------------- *
 * 第二层：中断后续跑
 * ------------------------------------------------------------------------- */

/** 造一条 `turn/end` 的 session/event。 */
function turnEndEvent(sessionId, reason) {
  return { type: 'turn/end', data: { turn: 1, reason } }
}

test('限流终结后，Agent 空闲时自动发送续跑消息', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness()
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  assert.equal(followed.length, 0, 'running 阶段不能直接发消息')

  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(followed.length, 1)

  const [message] = followed
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, '如果任务未完成，请继续执行')
  assert.equal(message.source.kind, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
})

test('continueText 可覆盖默认正文', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness({ continueText: '接着做' })
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(followed[0].content[0].text, '接着做')
})

test('continueSource: notice 时用提示条形态（不伪装成人打的）', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness({ continueSource: 'notice' })
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  harness.emit('agent/status', { agent, status: 'idle' })

  assert.equal(followed.length, 1)
  assert.equal(followed[0].source.kind, 'model-auto-retry')
  assert.equal(followed[0].source.form, 'notice')
  // 提示条只放一行摘要，不再把长正文塞进 summary
  assert.match(followed[0].source.summary, /429 限流：已自动续跑/)
  // 发给模型的正文仍然是配置里的那一条
  assert.equal(followed[0].content[0].text, '如果任务未完成，请继续执行')
})

test('非限流终结不续跑（鉴权失败必须人工处理）', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness()
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, {
    kind: 'error',
    error: { message: '403: model is not available', code: 'AUTH' },
  }))
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(followed.length, 0)
})

test('之后又成功走完一轮时，取消之前的待续跑登记', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness()
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  // 用户自己补了一条消息，并且这一轮正常结束。
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'completed' }))
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(followed.length, 0)
})

test('inbox 已有待处理输入时不插队', () => {
  const { agent, followed } = makeAgent()
  agent.inbox.hasPending = true
  const harness = createHarness()
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(followed.length, 0)
  assert.match(harness.logs.map(([, line]) => line).join('\n'), /inbox 已有待处理输入/)
})

test('Agent 已被销毁时不续跑', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness()
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  harness.agents.delete(agent.id)
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(followed.length, 0)
})

test('续跑预算用尽后放弃，并留下 warn 日志', () => {
  const { agent, followed } = makeAgent()
  const harness = createHarness({ maxContinues: 2 })
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  for (let i = 0; i < 3; i += 1) {
    harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
    harness.emit('agent/status', { agent, status: 'idle' })
  }
  assert.equal(followed.length, 2)
  assert.match(harness.logs.map(([, line]) => line).join('\n'), /放弃续跑/)
})

test('agent/disposed 清理该 Agent 的内存状态', () => {
  const { agent } = makeAgent()
  const harness = createHarness()
  harness.agents.set(agent.id, agent)

  const session = { id: agent.id }
  harness.emit('session/event', session, turnEndEvent(agent.id, { kind: 'error', error: rateLimitedFailure() }))
  harness.emit('agent/disposed', { agent })
  // 销毁后即使再来 idle，也不该有登记可发。
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(harness.logs.some(([, line]) => line.includes('已自动发送')), false)
})
