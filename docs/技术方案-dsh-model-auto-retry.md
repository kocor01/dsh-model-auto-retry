# DSH 模型限流自动续跑插件 —— 技术方案

> 状态：草案 v1（待评审）
> 目标读者：DSH 使用者 / 插件实现者
> 结论先行：**推荐「双层恢复」——第一层在 `agent/request-error` 处接管 429 原地重试，第二层在重试耗尽、Agent 已中断后自动注入「继续」**。只做第二层也能满足原始需求，但第一层体验更好、更省 token。

---

## 1. 背景与问题

### 1.1 现象

DSH 对模型请求失败有内置重试（`@deepseek-ai/dsh-llm-retry`）。达到 `retryPolicy.maxRetries` 后，失败变成终结错误：

1. `@deepseek-ai/dsh-agent-loop` 的 `step()` 在 `agent/request-error` waterfall 返回 `undefined` 时执行 `throw new LlmError(...)`；
2. `turn()` 捕获后写入 `turn/end { reason: { kind: 'error', error } }`，并触发 `agent/error`；
3. `kick()` 收尾，Agent 状态回到 `idle`，驱动退出。

结果：Agent 停住，必须人工输入「继续」才能恢复。额度/限流（HTTP 429）是最常见的触发原因。

### 1.2 真实日志证据（本机 `~/.dsh/sessions` 解压后统计）

```
llm/retry        {"provider":"sensenova","mode":"normal","retry":1,"maxRetries":5,
                  "failure":{"message":"429: {\"message\":\"rps exhausted\",\"type\":\"quota_exceeded_error\",\"code\":\"8\"}",
                             "code":"RATE_LIMIT"}}

turn/end         {"kind":"error",
                  "error":{"message":"429: {\"message\":\"tpm exhausted\",...}","code":"RATE_LIMIT"}}
```

两个关键事实：

- **失败对象里没有 `status` 字段**（`LlmFailure.status` 是可选字段，pi-ai/OpenAI 兼容适配器只写 `message` + `code`）；因此**不能只靠状态码 429 判定**，必须组合判定。
- 单个会话里出现过 **744 次 `llm/retry`、7 次 `turn/end` 为 error**：限流是高频事件，且确实会造成中断。

### 1.3 现有可用的零代码方案（基线）

`dsh-llm-retry` 支持 `retryPolicy.mode: 'always'`，配置后即无限重试：

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    retryPolicy:
      mode: always
      backoff: { initialDelayMs: 5000, maxDelayMs: 60000 }
```

优点：不动代码。缺点：**对所有错误无限重试**（鉴权失败、上下文超限、参数错误会永远卡住），没有上限、没有可见的「继续」动作、重试间隔最大只到 `maxDelayMs`（默认 10s，长时额度恢复等不到）。所以它只能作为临时止血，不能替代本插件。

---

## 2. 目标与非目标

### 目标

1. 429 / `RATE_LIMIT` 导致的模型请求失败**不再中断 Agent**（在限额场景下无人值守跑完长任务）。
2. 保留用户描述的行为作为兜底：重试确实耗尽、Agent 已中断时，**自动发送「继续」**让 Agent 继续执行。
3. 有界：重试次数、总时长、间隔都有上限，绝不会变成静默死循环。
4. 可观测：日志能看出「第几次、等多久、为什么放弃」。
5. 可关闭、可调参，且参数放在 profile 的 `cordis.patch.yml` 里，升级不丢。

### 非目标（v1 不做）

- 不做主动限速（token bucket / 请求排队）。
- 不做 UI 面板（不新增 Client 插件、不改聊天列表渲染）。
- 不覆盖非 429 的失败（鉴权、上下文超限、用户取消仍按原逻辑中断）。
- 不做跨进程/跨会话的全局配额调度。

---

## 3. 能力盘点（已用 `cordis_inspect_query` 核对当前运行实例）

| 扩展点 | 模式 | 契约要点 | 用途 |
| --- | --- | --- | --- |
| `agent/request-error` | waterfall | `{ agent, turn, step, provider, failure, retryPolicy, signal }` → `next()` → `{ kind:'retry' } \| undefined` | **第一层**：接管失败、原地重试 |
| `agent/error` | emit | `{ agent, turn, step, error }` | 辅助判定（可选） |
| `agent/status` | emit | `{ agent, status: 'idle' \| 'running' }` | **第二层**：等 Agent 真正空闲再注入 |
| `session/event` | emit | `(session, event)`，`turn/end.reason` 是持久事实 | 判定「终结 429」的权威来源 |
| `Agent.followup(message)` | 方法 | 写入 inbox 的 `next-turn` 并唤醒驱动 | 发送「继续」 |
| `Agent.inbox.hasPending` | 属性 | 是否有待处理输入 | 防止与他人输入打架 |
| `ctx.agents.get(id)` | 方法 | 存活判定 | 防止对已销毁 Agent 操作 |
| `LlmFailure` | 类型 | `{ message, code, status?, providerRetryAfterMs?, ... }` | 判定与退避输入 |

关键约束（来自官方 `practices`，已核对源码）：

- **禁止用新 `type` 追加 session 事件**（未知事件只有带 `ignorable: true` 才能在重开时被接受，而 `Session.append()` 无法设置该标记），所以插件**不能**写自己的持久事件；状态只能放内存或复用既有事件。
- `agent/request-error` 的 `next()` 是「下游策略」，只有在它返回 `undefined`（内置重试已放弃）时才轮到我们接管。
- 触发 `followup` 时必须 Agent 已 `idle`：在 `running` 阶段插入的消息不会被再次唤醒（`wakeDriver` 只在 idle 时真正起驱动），会滞留到下一次用户输入。

---

## 4. 方案对比

| 方案 | 机制 | 是否中断 | 是否可见 | 额外 token | 风险 |
| --- | --- | --- | --- | --- | --- |
| 0. 纯配置 `mode: always` | 内置重试无限循环 | 否 | 否 | 无 | 所有错误一起重试，可能永久卡死 |
| A. 请求期接管 | `agent/request-error` 返回 `{kind:'retry'}` | 否 | 否 | 无 | 长等待期间 UI 一直显示 running |
| B. 中断后续跑 | `turn/end(error)` + `agent/status(idle)` → `followup('继续')` | 是（一次） | 是（聊天里出现「继续」） | 多一轮完整请求 | 需要精确的时序与去重 |
| **A+B（推荐）** | 先 A 后 B | 极端情况下才中断 | 通常静默 | 仅 B 触发时 | 需要统一的计数器与上限 |

**推荐 A+B**：
- 正常限流（rps/tpm 打满）由 A 静默扛过，用户感知为「慢了一点」；
- A 达到自己的上限、或用户把 `mode` 设为 `continue` 时，退回 B，按原始需求注入「继续」；
- 两层共享同一套判定与预算，不会互相打架。

---

## 5. 总体架构

```
                     ┌─────────────────────────────────────────┐
  模型请求失败 ─────▶ │ agent/request-error (waterfall)         │
                     │  1. await next()  ← 先让内置 llm-retry 决定 │
                     │  2. 下游已 retry  → 原样返回               │
                     │  3. 下游放弃 + 429 → 退避等待 → retry      │
                     └───────────────┬─────────────────────────┘
                                     │ 超过 maxInLoopRetries / mode=continue
                                     ▼
   turn/end{error} ─────────▶ 记录「终结 429」            (session/event)
                                     │
   agent/status(idle) ──────▶ 预算够 & inbox 空 & Agent 存活
                                     ▼
                          Agent.followup(userMessage('继续'))
```

时序保证：`turn/end` 一定先于 `agent/status(idle)` 提交（`turn()` 的 `finally` 写 `turn/end`，`kick()` 的 `finally` 才切 idle），因此第二层的两个监听不会出现「先 idle 后记录」的竞态。

---

## 6. 详细设计

### 6.1 第一层：请求期接管（in-loop retry）

```js
async function onRequestError(payload, next) {
  const { agent, turn, step, failure, signal } = payload

  // 必须先把决策权交给下游：内置 llm-retry 若还能重试，就按它的来
  let downstream
  try { downstream = await next() } catch (error) { downstream = undefined }
  if (downstream?.kind === 'retry') return downstream

  if (!isRateLimited(failure, config)) return downstream
  if (signal.aborted || lifetime.signal.aborted) return undefined

  const attempt = bumpAttempt(agent.id, turn, step)
  if (attempt > config.maxInLoopRetries) return undefined   // 交给第二层

  const delayMs = nextDelay(failure, attempt, config)
  ctx.logger.info(`model-auto-retry: ${agent.id} 429，第 ${attempt} 次原地重试，等待 ${Math.round(delayMs)}ms`)

  if (!await sleep(delayMs, AbortSignal.any([signal, lifetime.signal]))) return undefined
  return { kind: 'retry' }
}
```

要点：

- **`next()` 优先**：保证与内置策略（以及未来任何插件）顺序无关；内置 5～10 次快速重试照常发生，我们只在它放弃后接手。
- `signal` 是 turn 的 abort 信号：用户点停止、会话归档都会让它 abort，等待立刻结束。
- 返回 `undefined` 与「不处理」等价，Agent 按原逻辑中断，第二层接手。

### 6.2 429 判定（关键，因为 `status` 可能缺失）

```js
function isRateLimited(failure, cfg) {
  if (failure === null || typeof failure !== 'object') return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (cfg.excludeCodes.includes(code)) return false          // QUOTA / ACCOUNT_QUOTA / AUTH ...
  if (cfg.rateLimitCodes.includes(code)) return true          // 'RATE_LIMIT' ← 实测主信号
  if (typeof failure.status === 'number' && cfg.rateLimitStatuses.includes(failure.status)) return true // 429
  return cfg.messagePattern !== '' && new RegExp(cfg.messagePattern).test(String(failure.message ?? ''))
}
```

默认：`rateLimitCodes: ['RATE_LIMIT']`、`rateLimitStatuses: [429]`、`messagePattern: '^\\s*429\\b'`、
`excludeCodes: ['QUOTA','ACCOUNT_QUOTA','AUTH','INVALID_CREDENTIAL','CONTEXT_WINDOW_EXCEEDED','EMPTY_RESPONSE']`。

三层判定兜住不同适配器：DeepSeek 官方适配器可能带 `status`，OpenAI 兼容（pi-ai）只给 `code` + `message`，极端情况下只有文本。`QUOTA` 类必须排除——那是账户余额/配额耗尽，重试无意义。

### 6.3 退避策略

```js
function nextDelay(failure, attempt, cfg) {
  const retryAfter = failure.providerRetryAfterMs
  if (cfg.respectRetryAfter && Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.min(retryAfter, cfg.maxDelayMs)
  const exp = Math.min(cfg.initialDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs)
  const jitter = 1 - cfg.jitterRatio + 2 * cfg.jitterRatio * Math.random()
  return Math.min(exp * jitter, cfg.maxDelayMs)
}
```

- 优先使用服务端 `Retry-After`（`failure.providerRetryAfterMs`），并受 `maxDelayMs` 截断。
- 否则指数退避 + 抖动，避免多会话同步撞墙。
- 默认从 **5s** 起，上限 **5min**，与内置重试的 0.5s→10s 快速档位互补。

### 6.4 状态与预算

内存态（不写 session 事件，规避格式约束）：

```js
const stepState = new Map()   // agentId -> { turn, step, attempt }   每次 (turn,step) 变化即归零
const pending   = new Map()   // sessionId -> { failure, at }         待注入「继续」的终结 429
const budget    = new Map()   // agentId -> { count, since }          第二层预算
const active    = new Set()   // 进行中的等待，卸载时 drain
```

上限三级：

1. `maxInLoopRetries`（默认 6）：单个 step 内第一层最多接管次数；
2. `maxContinues`（默认 8）：单个 Agent 在 `resetWindowMs`（默认 30 分钟）内的「继续」次数；
3. `maxDelayMs` 与 `respectRetryAfter`：单次等待上限。

任一超限：打 `warn` 日志 → 放行原错误 → 行为与今天完全一致（人工介入），绝不会静默吞掉错误。

### 6.5 第二层：注入「继续」

```js
// 记录终结 429（持久事实，权威）
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  const reason = event.data?.reason
  if (reason?.kind !== 'error') { pending.delete(session.id); return }
  if (!isRateLimited(reason.error, config)) return
  pending.set(session.id, { at: Date.now(), failure: reason.error })
})

// Agent 真正空闲后才发送，避免消息滞留在 running 阶段
ctx.on('agent/status', ({ agent, status }) => {
  if (status !== 'idle') return
  const record = pending.get(agent.id)
  pending.delete(agent.id)
  if (record === undefined) return
  if (ctx.agents.get(agent.id) !== agent) return
  if (!config.includeSubagents && (agent.session.header?.delegationDepth ?? 0) > 0) return
  if (agent.inbox.hasPending) return                       // 已有别人的输入，别抢
  if (!takeBudget(agent.id)) return                        // 预算不足，放弃
  agent.followup(continueMessage(config.continueText))
})
```

「继续」消息按真实用户消息的形状构造（无需 import 任何包）：

```js
function continueMessage(text) {
  return {
    id: crypto.randomUUID(),                 // 运行时只是字符串，brand 仅类型层
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'user',                          // 与 GUI 输入一致 → 聊天里正常渲染为用户气泡
      rpcId: crypto.randomUUID(),
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }
}
```

> 实现时需二次确认 `UserMessage['source']` 在 `@deepseek-ai/dsh-session` 中的字段要求（实测日志中真实用户消息为 `{"kind":"user","rpcId":"...","clientTimeZone":"Asia/Shanghai"}`，按此形状最安全）。

可选 `continueSource: 'notice'`：改用 `{ kind:'model-auto-retry', form:'notice', summary:'429 限流，已自动继续' }`，聊天里显示为提示条而不是伪装成用户输入，语义更诚实（v1 默认 `user`，符合原始需求）。

### 6.6 与内置 `llm-retry` 的协作

- 顺序无关：永远先 `await next()`，只有下游返回 `undefined` 才接管。
- 内置策略的持久重试计数（`llmRetry` projection，`step/start`/`turn/end` 归零）保持不变；我们**不写** `llm/retry` 事件（那是它的私有事件），只用内存计数。
- 若用户已把某 provider 设成 `mode: always`，内置策略永不让位，第一层自然失效——此时应改为 `normal` 才会用到本插件；文档中需说明。

### 6.7 取消与卸载

- 所有等待都 `AbortSignal.any([turnSignal, lifetime.signal])`，用户停止立即生效。
- 卸载：`lifetime.abort()` + `await Promise.allSettled([...active])`，与 `dsh-llm-retry` 的写法一致，保证热重载不留悬挂 Promise。
- 不使用定时器（默认 `continueDelayMs: 0`），避免卸载后仍触发 `followup`。若将来支持延迟续跑，必须把 timer 放进 `ctx.effect` 清理。

### 6.8 子 Agent

`agent/*` 事件对每个 Agent 都派发（含 subagent）。默认 `includeSubagents: true`：子 Agent 同样值得续跑。关闭时用 `agent.session.header.delegationDepth > 0` 过滤（实现前用 inspect 确认字段位置）。

### 6.9 可观测

- `ctx.logger.info`：每次接管、每次注入。
- `ctx.logger.warn`：超限放弃、竞态跳过、卸载中断。
- 不发自定义 Host 事件（v1 无消费者），不写自定义 session 事件（格式禁止）。

---

## 7. 配置（写入 `cordis.patch.yml`，随 upgrade 保留）

```yaml
- insert:
    - id: model-auto-retry
      name: '@local/dsh-model-auto-retry'
      config:
        mode: hybrid              # hybrid | in-loop | continue | off
        rateLimitCodes: ['RATE_LIMIT']
        rateLimitStatuses: [429]
        messagePattern: '^\s*429\b'
        excludeCodes: ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED']
        respectRetryAfter: true
        initialDelayMs: 5000
        maxDelayMs: 300000        # 5min
        jitterRatio: 0.2
        maxInLoopRetries: 6       # 第一层每个 step 的上限
        continueText: '继续'
        maxContinues: 8           # 第二层每个 Agent 的上限
        resetWindowMs: 1800000    # 30min 后预算归零
        includeSubagents: true
        continueSource: 'user'    # user | notice
```

配置校验：插件不导出 `Config` schema（避免引入 `@deepseek-ai/schemastery` 依赖），在 `apply` 内做**白名单 + 类型校验 + 默认值合并**，遇到未知键直接抛错并指明键名（与 `dsh-llm-retry` 的 `validateConfig` 风格一致），让写错的配置在激活期就暴露，而不是运行期静默失效。

---

## 8. 代码骨架（约 160 行，零外部依赖）

```js
// index.js
const DEFAULTS = { /* 见第 7 节 */ }

export const name = 'model-auto-retry'
export const inject = ['agents']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (config.mode === 'off') return

  const lifetime = new AbortController()
  const stepState = new Map()
  const pending = new Map()
  const budget = new Map()
  const active = new Set()

  const track = (p) => { const t = p.finally(() => active.delete(t)); active.add(t); return t }

  // 只注册三个真实事件；顺序：接管失败 → 记录终结错误 → 空闲时续跑
  const disposers = [
    ctx.on('agent/request-error', (payload, next) => {
      if (lifetime.signal.aborted || config.mode === 'continue') return next()
      return track(recoverInLoop(payload, next, ctx, config, lifetime, stepState))
    }),
    ctx.on('session/event', (session, event) => onTurnEnd(session, event, config, pending)),
    ctx.on('agent/status', ({ agent, status }) =>
      onIdle({ agent, status }, ctx, config, pending, budget)),
    ctx.on('agent/disposed', ({ agent }) => { stepState.delete(agent.id); pending.delete(agent.id); budget.delete(agent.id) }),
  ]

  ctx.effect(() => async () => {
    for (const dispose of disposers) dispose()
    lifetime.abort(new Error('model-auto-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'model-auto-retry: abort and drain')
}
```

完整实现另含 `recoverInLoop / onTurnEnd / onIdle / isRateLimited / nextDelay / bumpAttempt / takeBudget / continueMessage / sleep / normalizeConfig`，全部放在同一文件里，零 `@deepseek-ai/*` import，可直接 `node --check` 校验。核心两段见第 6.1 与 6.5 节。

---

## 9. 目录结构与安装

```
D:\code\dsh-model-auto-retry\
├─ docs\技术方案-dsh-model-auto-retry.md
├─ tools\read-session-log.mjs          # 解压并统计会话日志（验证用，已就绪）
└─ package\
   ├─ package.json
   ├─ cordis.patch.yml
   ├─ index.js
   ├─ locale\{en.json,zh.json}
   ├─ icon.svg
   └─ README.md
```

`package/package.json`：

```json
{
  "name": "@local/dsh-model-auto-retry",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`package/cordis.patch.yml`：

```yaml
- insert:
    - id: model-auto-retry
      name: '@local/dsh-model-auto-retry'
      config: { mode: hybrid }
```

安装：`plugin_manager` → `install_bundle`，`target` 传 `D:\code\dsh-model-auto-retry\package`。安装会写 profile 的 `package.json` / `cordis.patch.yml`，**不要手改 profile**；装完用 `cordis_inspect_list` + `Config.listConfigs` 确认行已激活，而不是看进程日志。

依赖策略：插件代码**不 import 任何 `@deepseek-ai/*` 包**（profile 安装的包无法解析 dsh 安装目录内的依赖树；模板同样采用零依赖写法）。代价是需要手写一个 `createUserMessage` 等价物（第 6.5 节），收益是安装与升级零耦合。

---

## 10. 验证方案

### 10.1 单元测试（`node --test`，无 dsh 运行时）

用假 `ctx`（`{ logger, on, effect, agents }`）驱动纯函数与状态机：

- `isRateLimited`：`{code:'RATE_LIMIT'}` ✅、`{status:429}` ✅、`{code:'QUOTA'}` ❌、`{code:'AUTH'}` ❌、`{message:'429: rps exhausted'}` ✅；
- 决策顺序：`next()` 返回 `{kind:'retry'}` 时**原样透传**且不计数；
- 超限：第 `maxInLoopRetries + 1` 次返回 `undefined`；
- 退避：指数、抖动区间、`Retry-After` 截断；
- 取消：等待期间 abort → 返回 `undefined` 且无 unhandled rejection。

### 10.2 端到端（真实 dsh + 假 429 服务）

`test/mock-429-server.mjs`：OpenAI 兼容端点，前 N 次返回 `429` + `Retry-After: 2` + `{"message":"rps exhausted","type":"quota_exceeded_error","code":"8"}`，之后返回正常的 SSE 流。

步骤：

1. 在 profile 的 `cordis.patch.yml` 临时加一个 `dsh-llm-pi-ai` provider 指向 `http://127.0.0.1:PORT/v1`，`retryPolicy.maxRetries: 1`（让内置重试快速让位）；
2. 用该 provider 跑一个短会话；
3. 用 `tools/read-session-log.mjs` 断言：
   - `llm/retry` 恰好 1 次（内置只跑一轮）；
   - **没有** `turn/end reason.kind = 'error'`；
   - 最终有 `assistant/message`；
   - 日志出现 `model-auto-retry: ... 原地重试`。
4. 切换 `mode: continue`、`maxRetries: 0`，重复：断言 `turn/end error` 出现一次后，紧接着出现 `user/message`（内容「继续」）与新的 `turn/start`，Agent 最终完成；
5. 还原 profile 配置（务必恢复，不能留下测试 provider）。

### 10.3 回归

- 非 429 失败（如 401/403）行为不变：仍中断、不注入「继续」；
- 用户点「停止」时立即结束等待，不产生额外 turn；
- 插件 `mode: off` 时零行为差异；
- 卸载插件不残留悬挂 Promise（`active` 集合为空）。

### 10.4 线上观测

跑一周后统计：`llm/retry` 次数与 `turn/end error` 比例、人工「继续」次数是否归零。对比基线（当前 7 次/会话的 error 中断）。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| `LlmFailure.status` 缺失（已实测） | 只判 429 会漏 | 三重判定：code / status / message 正则，可配置 |
| 把「额度耗尽」误判成限流 | 无限重试白等 | `excludeCodes` 排除 `QUOTA` / `ACCOUNT_QUOTA`；`maxInLoopRetries` 硬上限 |
| 无限循环 | 后台静默卡死 | 三级预算 + 超限放行 + `warn` 日志 |
| 长等待期间 UI 无反馈 | 用户以为卡死 | 日志记录 + README 说明；v2 可在聊天区加提示条 |
| 与内置重试顺序耦合 | 行为不确定 | 永远先 `next()`，只在放弃后接管 |
| 注入消息与他人输入冲突 | 消息滞留/重复 | `inbox.hasPending` 检查 + 预算去重 |
| 伪造成用户消息 | 会话记录看起来像人打的「继续」 | 提供 `continueSource: 'notice'` 诚实渲染 |
| 子 Agent 放大重试 | 并发翻倍 | `includeSubagents` 开关 |
| 无法解析 dsh 包 | 插件装不上/启动失败 | 零 import，只用 Node 内置（`node:crypto`） |
| 插件卸载时仍在等待 | 悬挂 Promise / 热重载泄漏 | 与官方 `llm-retry` 相同的 lifetime abort + drain |

---

## 12. 里程碑

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| M1 | 骨架 + 判定 + 第一层 + 单测 | 可 `node --check` 的 `index.js`，单测全绿 |
| M2 | 第二层「继续」+ 预算 | 完整两段恢复 |
| M3 | mock 429 端到端（hybrid / continue 两种模式） | 会话日志断言通过 |
| M4 | 安装到 `desktop` profile + 真实限流观察 | 一行插件记录 + 一次真实 429 恢复验证 |
| M5 | README（安装/调参/排障）+ 默认可行性回收 | 用户可自助使用 |

---

## 附录 A：为什么不用 `llm/stream` 拦截

`llm/stream` 是**每次模型调用**（含标题生成、摘要、子 Agent）的 waterfall，它拿不到「这是某个 step 的第几次失败」和 turn 的 abort 信号，重试还要自己实现流式重放。`agent/request-error` 是宿主专门为「一次失败的请求尝试」设计的扩展点，语义、状态与取消都已就绪。

## 附录 B：为什么状态放内存而不是 projection

官方约束禁止追加新事件类型，而没有自有事件就没有可折叠的持久状态；projection 只能是内存缓存的重建物。本插件的计数本质是「进程内的重试预算」，热重载后归零是可接受甚至更安全的行为（重新获得预算），因此内存 Map + `(turn, step)` 归零足够。

---

## 附录 C：实现与验证记录（v0.1.0）

### 落地位置

| 文件 | 说明 |
| --- | --- |
| `package/index.js` | 全部实现（约 620 行，含详细注释），零 `@deepseek-ai/*` 依赖 |
| `package/cordis.patch.yml` | 在 profile 根部插入 `model-auto-retry` 行 |
| `package/README.md` | 安装、配置、验证、排障 |
| `test/unit.test.mjs` | 27 个用例，假 ctx 驱动两层与全部分支 |
| `test/mock-429-server.mjs` | OpenAI 兼容假 429 服务 |
| `tools/read-session-log.mjs` | 解压多帧 zstd 会话日志并统计事件 |

### 与设计稿的偏差（实现时发现并修正）

1. **`rateLimitStatuses` 同时接受 `[429]` 与 `['429']`。** YAML 里数字与数字字符串都常见，只收 number 会让加引号的写法在激活期报错（`readStatusArray`）。
2. **子 Agent 判定改用 `ctx.agents.isOwnedBy()`。** 设计稿写的是读 `agent.session.header.delegationDepth`，但那是内部字段位置、跨版本不稳；公开 API「某个其它 Agent 是否拥有它」更可靠（`isSubagentAgent`）。
3. **`agent/request-error` 监听器内再加一层 `catch`。** 插件内部异常若向上冒泡会把宿主 turn 一起带崩；现在退回「不处理」，行为与未安装一致。
4. **`followup` 前做能力检测。** `Agent` 接口只声明了 `id`，具体驱动才有 `followup`，缺方法时记日志跳过而不是抛错。

### 验证结果

**单元测试：27/27 通过**（`node test/unit.test.mjs`）。

**端到端 A/B（隔离 `DSH_HOME`，同一假服务、同一 prompt）**：

| 场景 | 假服务 | 内置重试 | 结果 |
| --- | --- | --- | --- |
| `mode: off`（对照） | 3×429，之后 200 | `maxRetries: 1` | `turn/end error`，CLI 退出码非 0，报 `RATE_LIMIT: 429 ...` |
| `mode: hybrid` | 3×429，之后 200 | `maxRetries: 1` | `turn/end completed`，输出 `done`，退出码 0 |

开启插件那次的关键计数：假服务收到 **4** 个请求；会话日志里 `llm/retry` **1** 次（内置的）、
`assistant/attempt` **2** 次、无 error 的 `turn/end`。第 4 个请求正是内置重试耗尽后由插件发出的
原地重试 —— 因果链闭合。

### 安装状态

已通过 `plugin_manager install_bundle` 装入 `desktop` profile（`application: applied`，无警告），
`Config.listConfigs` 能看到 `model-auto-retry` 行且 `packageDir` 指向 profile 的链接目录。
该插件不导出 `Config` schema，因此该行的 `status` 显示为 `absent`（= 无配置表单），不代表未挂载。

未验证项：desktop profile 下真实限流的一次恢复（需要真实 429，无法按需构造），留待日常使用观察。

