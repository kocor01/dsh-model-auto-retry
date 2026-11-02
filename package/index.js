/**
 * dsh-model-auto-retry —— 模型限流（HTTP 429）自动恢复插件
 *
 * ## 要解决的问题
 *
 * DSH 对失败的模型请求有内置重试（`@deepseek-ai/dsh-llm-retry`）。重试次数用完后，
 * `@deepseek-ai/dsh-agent-loop` 会把这次失败升级成终结错误：写入
 * `turn/end { reason: { kind: 'error' } }`、发出 `agent/error`、Agent 回到 `idle`。
 * 结果就是任务停在半路，必须人工再打一句「继续」。真实环境下最常见的触发原因
 * 就是额度/限流（HTTP 429）。
 *
 * ## 恢复策略：两层
 *
 * 第一层（请求期接管，`agent/request-error` waterfall）
 *   宿主在每一个失败的请求尝试之后都会发这个事件，监听器返回 `{ kind: 'retry' }`
 *   就能让循环**原地重试同一个 step**，Agent 根本不会中断：不丢上下文、不多发一轮
 *   完整请求。内置的 `dsh-llm-retry` 用的就是这个接口，所以我们必须**先 `await next()`**，
 *   让它先把 5~10 次快速重试跑完，只有它放弃（返回 `undefined`）后才由我们接手，
 *   并且用更长的退避（默认 5s 起、最长 5min）等额度窗口过去。
 *
 * 第二层（中断后续跑，`session/event` + `agent/status`）
 *   第一层达到自己的上限、或用户把 mode 设成 `continue` 时，错误会照常终结这一次
 *   turn。插件从持久事实 `turn/end.reason.error` 里认出 429，然后在 Agent 真正回到
 *   `idle` 之后调用 `agent.followup()` 注入一条续跑消息，把任务接上。正文默认是
 *   「如果任务未完成，请继续执行」（见配置 `continueText`）——带上「未完成」这个前提，
 *   模型才不会把续跑当成一条新的、与当前任务无关的指令。
 *
 * ## 两个不能踩的时序/格式约束
 *
 * 1. **必须等 `idle` 再发「继续」。** `followup()` 在 Agent `running` 阶段只会把消息
 *    放进 `next-turn` 队列，而 `wakeDriver()` 只在 `idle` 时真正启动驱动；如果在
 *    `running` 阶段插入，消息会滞留到下一次用户输入才被捡起来。
 *    好消息是 `turn/end` 一定先于 `agent/status(idle)` 提交（前者在 `turn()` 的
 *    finally 里，后者在 `kick()` 的 finally 里），所以「先记录、后触发」不会丢事件。
 *
 * 2. **不能写自定义 session 事件。** 宿主只接受带 `ignorable: true` 的未知事件，
 *    而存活的 `Session.append()` 无法设置该标记，硬写会让会话无法重新打开。
 *    因此本插件的全部状态都放在进程内存里（重启/热重载后归零，等于重新拿到预算）。
 *
 * ## 依赖策略
 *
 * 插件**不 import 任何 `@deepseek-ai/*` 包**：profile 里安装的包解析不到 dsh 安装
 * 目录内的依赖树。需要的能力（构造用户消息、生成 id）用 Node 内置模块实现，
 * 见 `continueMessage()`。
 *
 * @module @local/dsh-model-auto-retry
 */

import { randomUUID } from 'node:crypto'

/** Cordis 插件名。同时作为日志前缀，排障时按它过滤即可。 */
export const name = 'model-auto-retry'

/**
 * 必需服务。
 *
 * 只声明 `agents`：没有 Agent 注册表就没有会话可救，插件应保持「未激活」，
 * 而不是在别的 profile 里激活后抛错。其余服务都用可选访问（`?.`）读取。
 */
export const inject = ['agents']

/**
 * 配置键白名单。
 *
 * 严格校验的理由：`cordis.patch.yml` 里写错一个键（例如 `maxRetry` 少个 s）如果被
 * 静默忽略，表现就是「插件装了但好像没生效」，极难排查。所以遇到未知键直接抛错，
 * 让 Loader 在激活期就把问题暴露出来。
 */
const CONFIG_KEYS = new Set([
  'mode',
  'rateLimitCodes',
  'rateLimitStatuses',
  'messagePattern',
  'excludeCodes',
  'respectRetryAfter',
  'initialDelayMs',
  'maxDelayMs',
  'jitterRatio',
  'maxInLoopRetries',
  'continueText',
  'maxContinues',
  'resetWindowMs',
  'includeSubagents',
  'continueSource',
])

/**
 * 默认配置。
 *
 * 数值都是围绕「服务端说 429，额度窗口通常以秒到分钟计」选的：
 * 起始 5s、上限 5min，与外置内置重试的 0.5s→10s 快速档位互补。
 */
const DEFAULTS = Object.freeze({
  /** 恢复模式：hybrid = 两层都开；in-loop = 只原地重试；continue = 只中断后续跑；off = 关闭。 */
  mode: 'hybrid',
  /** 认定为限流的 LlmFailure.code（大小写不敏感）。实测 OpenAI 兼容适配器给 'RATE_LIMIT'。 */
  rateLimitCodes: Object.freeze(['RATE_LIMIT']),
  /** 认定为限流的 HTTP 状态码。DeepSeek 官方适配器会在 failure.status 里带上。 */
  rateLimitStatuses: Object.freeze([429]),
  /** 消息文本兜底匹配。实测 pi-ai 的消息形如 "429: {\"message\":\"rps exhausted\"...}"。 */
  messagePattern: '^\\s*429\\b',
  /** 永不自动重试的 code：配额/余额/A 鉴权/上下文超限重试多少次都不会变好。 */
  excludeCodes: Object.freeze([
    'QUOTA',
    'ACCOUNT_QUOTA',
    'AUTH',
    'INVALID_CREDENTIAL',
    'CONTEXT_WINDOW_EXCEEDED',
  ]),
  /** 是否优先使用服务端 Retry-After（failure.providerRetryAfterMs）。 */
  respectRetryAfter: true,
  /** 第一次原地重试前的等待时间。 */
  initialDelayMs: 5000,
  /** 单次等待上限，同时是 Retry-After 的截断值。 */
  maxDelayMs: 300000,
  /** 抖动比例 0~1，避免多个会话/子 Agent 同步撞墙。 */
  jitterRatio: 0.2,
  /** 第一层：同一个 step 内最多接管多少次。0 表示完全交给第二层。 */
  maxInLoopRetries: 6,
  /** 第二层注入的消息正文：带「未完成」前提，避免模型把续跑当成新的用户指令。 */
  continueText: '如果任务未完成，请继续执行',
  /** 第二层：同一 Agent 在 resetWindowMs 窗口内最多续跑多少次。 */
  maxContinues: 8,
  /** 续跑预算的滑动窗口长度。 */
  resetWindowMs: 1800000,
  /** 是否对子 Agent 也生效。 */
  includeSubagents: true,
  /** 「继续」消息的渲染形态：user = 普通用户气泡；notice = 提示条（不伪装成人打的）。 */
  continueSource: 'user',
})

/* ------------------------------------------------------------------------- *
 * 配置校验
 * ------------------------------------------------------------------------- */

/**
 * 构造带键名的配置错误，方便在 Loader 日志里直接定位到 `cordis.patch.yml` 的哪一行。
 * @param {string} key - 出错的配置键。
 * @param {string} expectation - 期望值的简短英文描述。
 * @returns {Error} 带插件前缀的错误。
 */
function configError(key, expectation) {
  return new Error(`model-auto-retry: config "${key}" ${expectation}`)
}

/**
 * 读一个枚举值。
 * @param {Record<string, unknown>} input - 原始配置。
 * @param {string} key - 键名。
 * @param {string} fallback - 缺省值。
 * @param {readonly string[]} allowed - 允许的取值。
 * @returns {string} 校验后的值。
 */
function readEnum(input, key, fallback, allowed) {
  const value = input[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw configError(key, `must be one of ${allowed.map((v) => `"${v}"`).join(', ')}`)
  }
  return value
}

/**
 * 读一个数值（可选整数约束与上下界）。
 * @param {Record<string, unknown>} input - 原始配置。
 * @param {string} key - 键名。
 * @param {number} fallback - 缺省值。
 * @param {{integer?: boolean, min?: number, max?: number}} [bounds] - 约束。
 * @returns {number} 校验后的值。
 */
function readNumber(input, key, fallback, bounds = {}) {
  const value = input[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw configError(key, 'must be a finite number')
  if (bounds.integer === true && !Number.isSafeInteger(value)) throw configError(key, 'must be a safe integer')
  if (bounds.min !== undefined && value < bounds.min) throw configError(key, `must be >= ${bounds.min}`)
  if (bounds.max !== undefined && value > bounds.max) throw configError(key, `must be <= ${bounds.max}`)
  return value
}

/**
 * 读一个字符串数组。
 * @param {Record<string, unknown>} input - 原始配置。
 * @param {string} key - 键名。
 * @param {readonly string[]} fallback - 缺省值。
 * @returns {readonly string[]} 去重并保留大小写的不可变数组。
 */
function readStringArray(input, key, fallback) {
  const value = input[key]
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw configError(key, 'must be an array of non-empty strings')
  }
  return Object.freeze([...new Set(value)])
}

/**
 * 读一个正整数数组（HTTP 状态码用）。
 *
 * 单独一个函数是因为 YAML 里写 `[429]` 得到的是 number，而 `['429']` 是 string；
 * 两种写法都接受，避免用户因为意外的加引号而在激活期报错。
 *
 * @param {Record<string, unknown>} input - 原始配置。
 * @param {string} key - 键名。
 * @param {readonly number[]} fallback - 缺省值。
 * @returns {readonly number[]} 去重后的不可变数组。
 */
function readStatusArray(input, key, fallback) {
  const value = input[key]
  if (value === undefined) return fallback
  if (!Array.isArray(value)) throw configError(key, 'must be an array of positive integers')
  const numbers = value.map((entry) => (typeof entry === 'string' ? Number(entry) : entry))
  if (numbers.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
    throw configError(key, 'must be an array of positive integers')
  }
  return Object.freeze([...new Set(numbers)])
}

/**
 * 把原始配置规范化成内部使用的不可变对象。
 *
 * 只做校验与补默认值，不做语义转换；跨字段约束（maxDelayMs >= initialDelayMs）放在最后统一检查。
 *
 * @param {unknown} raw - `cordis.patch.yml` 里这一行的 config。
 * @returns {Readonly<typeof DEFAULTS> & { messageTest: RegExp | undefined, codeSet: ReadonlySet<string>, excludeSet: ReadonlySet<string> }>}
 *   规范化后的配置；额外派生三个便于热路径判断的字段。
 */
function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('model-auto-retry: config must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`model-auto-retry: unknown config key "${key}"`)
  }

  const mode = readEnum(raw, 'mode', DEFAULTS.mode, ['hybrid', 'in-loop', 'continue', 'off'])
  const rateLimitCodes = readStringArray(raw, 'rateLimitCodes', DEFAULTS.rateLimitCodes)
  const rateLimitStatuses = readStatusArray(raw, 'rateLimitStatuses', DEFAULTS.rateLimitStatuses)
  const excludeCodes = readStringArray(raw, 'excludeCodes', DEFAULTS.excludeCodes)
  const messagePattern = raw.messagePattern === undefined
    ? DEFAULTS.messagePattern
    : (typeof raw.messagePattern === 'string' ? raw.messagePattern : null)
  if (messagePattern === null) throw configError('messagePattern', 'must be a string')

  const respectRetryAfter = raw.respectRetryAfter === undefined
    ? DEFAULTS.respectRetryAfter
    : (typeof raw.respectRetryAfter === 'boolean' ? raw.respectRetryAfter : null)
  if (respectRetryAfter === null) throw configError('respectRetryAfter', 'must be a boolean')

  const initialDelayMs = readNumber(raw, 'initialDelayMs', DEFAULTS.initialDelayMs, { min: 1 })
  const maxDelayMs = readNumber(raw, 'maxDelayMs', DEFAULTS.maxDelayMs, { min: 1 })
  if (initialDelayMs > maxDelayMs) throw configError('initialDelayMs', 'must be <= maxDelayMs')

  const continueText = raw.continueText === undefined
    ? DEFAULTS.continueText
    : (typeof raw.continueText === 'string' && raw.continueText.length > 0 ? raw.continueText : null)
  if (continueText === null) throw configError('continueText', 'must be a non-empty string')

  const includeSubagents = raw.includeSubagents === undefined
    ? DEFAULTS.includeSubagents
    : (typeof raw.includeSubagents === 'boolean' ? raw.includeSubagents : null)
  if (includeSubagents === null) throw configError('includeSubagents', 'must be a boolean')

  const continueSource = readEnum(raw, 'continueSource', DEFAULTS.continueSource, ['user', 'notice'])

  // messagePattern 编译成 RegExp；主动去掉 g/y 标志，避免共享正则的 lastIndex 状态污染判定。
  let messageTest
  if (messagePattern.length > 0) {
    try {
      messageTest = new RegExp(messagePattern, 'i')
    } catch (error) {
      throw configError('messagePattern', `is not a valid regular expression (${renderError(error)})`)
    }
  }

  return Object.freeze({
    mode,
    rateLimitCodes,
    rateLimitStatuses,
    messagePattern,
    messageTest,
    excludeCodes,
    respectRetryAfter,
    initialDelayMs,
    maxDelayMs,
    jitterRatio: readNumber(raw, 'jitterRatio', DEFAULTS.jitterRatio, { min: 0, max: 1 }),
    maxInLoopRetries: readNumber(raw, 'maxInLoopRetries', DEFAULTS.maxInLoopRetries, { integer: true, min: 0 }),
    continueText,
    maxContinues: readNumber(raw, 'maxContinues', DEFAULTS.maxContinues, { integer: true, min: 0 }),
    resetWindowMs: readNumber(raw, 'resetWindowMs', DEFAULTS.resetWindowMs, { integer: true, min: 0 }),
    includeSubagents,
    continueSource,
    // 派生集合：热路径上每次失败都要判定，避免重复 toUpperCase。
    codeSet: new Set(rateLimitCodes.map((code) => code.toUpperCase())),
    excludeSet: new Set(excludeCodes.map((code) => code.toUpperCase())),
  })
}

/* ------------------------------------------------------------------------- *
 * 判定与退避
 * ------------------------------------------------------------------------- */

/**
 * 把任意抛出物渲染成一行可读文本，仅用于日志。
 * @param {unknown} value - catch 到的值。
 * @returns {string} 文本。
 */
function renderError(value) {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 判断一个 `LlmFailure` 是否属于「等一会儿就能好」的限流失败。
 *
 * 三重判定是实测逼出来的：`LlmFailure.status` 是可选字段，OpenAI 兼容适配器
 * （pi-ai）只写 `code` 和 `message`，DeepSeek 官方适配器才可能带 `status`。
 * 只判 429 会漏，只判 code 会漏掉别的适配器，所以三条独立命中任一即算。
 * `excludeCodes` 优先级最高：配额/余额/鉴权类的 429 重试多少次都不会成功。
 *
 * @param {unknown} failure - `agent/request-error` / `turn/end.reason.error` 带来的失败对象。
 * @param {ReturnType<typeof normalizeConfig>} config - 规范化配置。
 * @returns {boolean} 是否应当自动重试。
 */
function isRateLimited(failure, config) {
  if (failure === null || typeof failure !== 'object') return false
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : ''
  if (code.length > 0 && config.excludeSet.has(code)) return false
  if (code.length > 0 && config.codeSet.has(code)) return true
  if (typeof failure.status === 'number' && config.rateLimitStatuses.includes(failure.status)) return true
  if (config.messageTest !== undefined) {
    const message = typeof failure.message === 'string' ? failure.message : ''
    if (message.length > 0 && config.messageTest.test(message)) return true
  }
  return false
}

/**
 * 计算这一次重试要等多久。
 *
 * 优先级：服务端 `Retry-After` > 指数退避（带抖动）。两者都被 `maxDelayMs` 截断。
 * 指数用 `2 ** (attempt - 1)`，所以第 1 次是 initialDelayMs 本身。
 *
 * @param {{providerRetryAfterMs?: unknown}} failure - 失败对象。
 * @param {number} attempt - 本 step 内第几次接管（从 1 开始）。
 * @param {ReturnType<typeof normalizeConfig>} config - 规范化配置。
 * @returns {number} 毫秒数，落在 (0, maxDelayMs]。
 */
function nextDelay(failure, attempt, config) {
  const retryAfter = failure?.providerRetryAfterMs
  if (config.respectRetryAfter && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, config.maxDelayMs)
  }
  const exponential = Math.min(config.initialDelayMs * 2 ** (attempt - 1), config.maxDelayMs)
  // jitterRatio = 0.2 时把间隔乘到 [0.8, 1.2] 区间，避免多会话同时醒来再次撞墙。
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * Math.random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

/**
 * 可被 AbortSignal 打断的等待。
 *
 * 用户点「停止」、会话被归档、插件卸载都会让 signal abort；此时立即返回 false，
 * 不留下悬挂的定时器（否则热重载会泄漏）。
 *
 * @param {number} ms - 等待时长。
 * @param {AbortSignal} signal - 组合信号。
 * @returns {Promise<boolean>} true = 正常等完；false = 被取消。
 */
function sleep(ms, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // 竞态兜底：注册监听的瞬间 signal 可能刚好 abort，此时不会再触发事件。
    if (signal.aborted) onAbort()
  })
}

/* ------------------------------------------------------------------------- *
 * 第一层：请求期接管
 * ------------------------------------------------------------------------- */

/**
 * 更新并返回「当前 step 的第几次接管」。
 *
 * 计数按 `(turn, step)` 归零：换了 step 就是新的失败链，预算重新计算。
 * 只保留每个 Agent 一条记录，Map 大小等于活跃 Agent 数，不会随会话增长。
 *
 * @param {Map<string, {turn: number, step: number, attempt: number}>} stepState - 计数表。
 * @param {string} agentId - Agent/Session id。
 * @param {number} turn - turn 序号。
 * @param {number} step - step 序号。
 * @returns {number} 本次的序号（1 起）。
 */
function bumpAttempt(stepState, agentId, turn, step) {
  const previous = stepState.get(agentId)
  const attempt = previous !== undefined && previous.turn === turn && previous.step === step
    ? previous.attempt + 1
    : 1
  stepState.set(agentId, { turn, step, attempt })
  return attempt
}

/**
 * 第一层的核心：在失败的请求尝试之后决定是否原地重试。
 *
 * 关键顺序（错了就会和内置策略打架）：
 *   1. 先 `await next()` —— 内置 `dsh-llm-retry` 若还能重试就让它重试，我们只当最后一层；
 *   2. 下游返回 `{ kind: 'retry' }` 说明它已经接管，原样透传，不计数、不等待；
 *   3. 只有下游返回 `undefined`（内置重试确实用完了）且判定为限流时，才由我们等待并重试。
 *
 * 这个顺序让插件与注册顺序解耦：无论我们排在 `llm-retry` 前面还是后面，行为都一致。
 *
 * @param {object} payload - `agent/request-error` 的载荷。
 * @param {() => Promise<{kind: 'retry'} | undefined>} next - 下游决策。
 * @param {object} deps - 依赖注入（配置、状态表、生命周期信号）。
 * @returns {Promise<{kind: 'retry'} | undefined>} 决策结果。
 */
async function recoverInLoop(payload, next, deps) {
  const { ctx, config, lifetime, stepState } = deps
  const { agent, turn, step, failure, signal } = payload ?? {}

  // 载荷不完整（未来版本字段改名等）时不要假装能处理，直接交回下游。
  if (agent === undefined || typeof agent.id !== 'string') return next()

  // 下游若自己抛错，保持宿主原有语义让它冒泡：不能吞掉别人插件的失败。
  const downstream = await next()
  if (downstream?.kind === 'retry') return downstream

  if (!isRateLimited(failure, config)) return downstream

  // 用户已停止 / 插件已卸载：不再等待，交给宿主按原逻辑中断。
  if (signal?.aborted === true || lifetime.signal.aborted) return undefined

  const attempt = bumpAttempt(stepState, agent.id, turn, step)
  if (attempt > config.maxInLoopRetries) {
    ctx.logger.warn(
      `model-auto-retry: agent "${agent.id}" turn ${turn} step ${step} 第 ${attempt} 次限流，` +
      `已达 maxInLoopRetries=${config.maxInLoopRetries}，放行给续跑层`,
    )
    return undefined
  }

  const delayMs = Math.round(nextDelay(failure, attempt, config))
  ctx.logger.info(
    `model-auto-retry: agent "${agent.id}" turn ${turn} step ${step} 命中限流` +
    `（code=${failure.code ?? 'n/a'}, status=${failure.status ?? 'n/a'}），` +
    `第 ${attempt}/${config.maxInLoopRetries} 次原地重试，等待 ${delayMs}ms`,
  )

  // 组合信号：turn 的取消（用户停止）与插件卸载任一发生都立即结束等待。
  const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
  if (!await sleep(delayMs, fused)) {
    ctx.logger.info(`model-auto-retry: agent "${agent.id}" 的等待被取消（用户停止或插件卸载）`)
    return undefined
  }
  return { kind: 'retry' }
}

/* ------------------------------------------------------------------------- *
 * 第二层：中断后续跑
 * ------------------------------------------------------------------------- */

/**
 * 从 `turn/end` 里认出「终结的限流错误」，登记为待续跑。
 *
 * 用 `turn/end` 而不是 `agent/error` 作权威来源：前者是持久事实，字段形状与
 * `llm-retry` 的重试记录一致；后者只是过程通知。
 *
 * 任何一次非错误的 turn 结束都会清掉登记 —— 说明会话自己走通了，不该再补「继续」。
 *
 * @param {object} session - 会话对象。
 * @param {{type: string, data?: any}} event - session/event 的事件。
 * @param {object} deps - 依赖注入。
 */
function onTurnEnd(session, event, deps) {
  const { ctx, config, pending } = deps
  if (event?.type !== 'turn/end') return

  const reason = event.data?.reason
  if (reason?.kind !== 'error') {
    pending.delete(session.id)
    return
  }
  if (!isRateLimited(reason.error, config)) {
    pending.delete(session.id)
    return
  }

  // 只登记，不发送：此刻 Agent 还在 running 阶段，发消息会滞留在队列里。
  pending.set(session.id, { at: Date.now(), failure: reason.error })
  ctx.logger.info(
    `model-auto-retry: agent "${session.id}" 的 turn 因限流终结` +
    `（code=${reason.error?.code ?? 'n/a'}），登记一次自动续跑`,
  )
}

/**
 * Agent 回到 idle 时，如果它上一轮是被限流打断的，就注入「继续」。
 *
 * 发送前的五道闸门，任何一道不满足都放弃（并留下日志），保证不会和用户输入抢跑、
 * 不会对已销毁的 Agent 操作、不会无限续跑：
 *   1. 有登记（上一轮确实是限流终结）；
 *   2. Agent 仍存活（同一个对象，防止 id 复用）；
 *   3. 子 Agent 开关允许；
 *   4. inbox 为空（用户已经自己发了消息，或别的插件排了活）；
 *   5. 续跑预算没超。
 *
 * @param {{agent?: object, status?: string}} payload - `agent/status` 的载荷。
 * @param {object} deps - 依赖注入。
 */
function onIdle(payload, deps) {
  const { ctx, config, pending, budget } = deps
  const agent = payload?.agent
  if (payload?.status !== 'idle' || agent === undefined) return

  const record = pending.get(agent.id)
  pending.delete(agent.id)
  if (record === undefined) return

  // 闸门 2：Agent 可能已在等待期间被销毁（会话关闭、父 Agent 回收）。
  if (ctx.agents.get(agent.id) !== agent) return

  // 闸门 3：子 Agent 是否也参与（默认参与）。
  if (!config.includeSubagents && isSubagentAgent(ctx, agent)) return

  // 闸门 4：用户可能已经在错误提示后自己打了「继续」，此时别再补一条。
  if (agent.inbox?.hasPending === true) {
    ctx.logger.info(`model-auto-retry: agent "${agent.id}" 的 inbox 已有待处理输入，跳过自动续跑`)
    return
  }

  // 闸门 5：预算。
  if (!takeContinueBudget(budget, agent.id, config, Date.now())) {
    ctx.logger.warn(
      `model-auto-retry: agent "${agent.id}" 在 ${config.resetWindowMs}ms 内已自动续跑 ` +
      `${config.maxContinues} 次，放弃续跑，保留错误等待人工处理`,
    )
    return
  }

  const followup = agent.followup
  if (typeof followup !== 'function') {
    ctx.logger.warn(`model-auto-retry: agent "${agent.id}" 不支持 followup()，跳过自动续跑`)
    return
  }

  try {
    followup.call(agent, continueMessage(config))
    ctx.logger.info(`model-auto-retry: agent "${agent.id}" 已自动发送续跑消息「${config.continueText}」`)
  } catch (error) {
    // 发送失败（例如刚好被销毁）不能让插件自身崩掉，也不重试：日志足够定位。
    ctx.logger.warn(`model-auto-retry: agent "${agent.id}" 自动续跑失败：${renderError(error)}`)
  }
}

/**
 * 判断一个 Agent 是否是别的 Agent 的子会话。
 *
 * 用公开的注册表 API 实现，避免依赖 `session.header`（不同版本字段位置可能变化）：
 * 若某个其它 Agent 拥有它，它就是子 Agent。
 *
 * @param {object} ctx - 插件上下文（需要 `ctx.agents`）。
 * @param {object} agent - 目标 Agent。
 * @returns {boolean} 是否子 Agent；判断失败时按「不是」处理（宁可按默认参与）。
 */
function isSubagentAgent(ctx, agent) {
  try {
    const registry = ctx.agents
    if (typeof registry?.list !== 'function' || typeof registry.isOwnedBy !== 'function') return false
    return registry.list().some((other) => other !== agent && registry.isOwnedBy(agent.id, other))
  } catch {
    return false
  }
}

/**
 * 取一次续跑预算（滑动窗口计数）。
 *
 * 窗口语义：从窗口内第一次续跑开始计时，`resetWindowMs` 之后计数归零。
 * 这样「偶发限流」不会累积到上限，而「持续性额度耗尽」最多续跑 maxContinues 次就停。
 *
 * @param {Map<string, {count: number, since: number}>} budget - 预算表。
 * @param {string} agentId - Agent id。
 * @param {ReturnType<typeof normalizeConfig>} config - 规范化配置。
 * @param {number} now - 当前时间戳。
 * @returns {boolean} 是否拿到预算。
 */
function takeContinueBudget(budget, agentId, config, now) {
  if (config.maxContinues <= 0) return false
  const record = budget.get(agentId)
  if (record === undefined || now - record.since > config.resetWindowMs) {
    budget.set(agentId, { count: 1, since: now })
    return true
  }
  if (record.count >= config.maxContinues) return false
  record.count += 1
  return true
}

/**
 * 构造要注入的「继续」消息。
 *
 * 不 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：它只做了
 * `{ role: 'user', ...input, id: brandString(uuid) }` 这一件事，而 brand 只是类型层
 * 的标记，运行时就是字符串。这里按实测的真实用户消息形状构造：
 *   { kind: 'user', rpcId: uuid, clientTimeZone: IANA }
 * 这样 GUI 会把它渲染成普通用户气泡（`continueSource: 'user'`），
 * 或者用 `notice` 形态渲染成提示条，避免伪造「人打过这句话」的观感。
 *
 * @param {ReturnType<typeof normalizeConfig>} config - 规范化配置。
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: object}} 消息。
 */
function continueMessage(config) {
  const content = [{ type: 'text', text: config.continueText }]
  if (config.continueSource === 'notice') {
    return {
      id: randomUUID(),
      role: 'user',
      content,
      source: {
        kind: 'model-auto-retry',
        form: 'notice',
        summary: '429 限流：已自动续跑',
      },
    }
  }
  const source = { kind: 'user', rpcId: randomUUID() }
  // clientTimeZone 只是展示用元数据；拿不到时直接省略，避免写入 undefined 键。
  const zone = localTimeZone()
  if (zone !== undefined) source.clientTimeZone = zone
  return { id: randomUUID(), role: 'user', content, source }
}

/**
 * 读本机 IANA 时区，失败时返回 undefined。
 * @returns {string | undefined} 例如 `Asia/Shanghai`。
 */
function localTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.length > 0 ? zone : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * 插件入口
 * ------------------------------------------------------------------------- */

/**
 * 安装插件。
 *
 * 注册的监听器：
 *   - `agent/request-error` —— 第一层（mode = hybrid | in-loop）
 *   - `session/event`       —— 第二层：记录终结的限流错误（mode = hybrid | continue）
 *   - `agent/status`        —— 第二层：idle 时注入「继续」（mode = hybrid | continue）
 *   - `agent/disposed`      —— 清理该 Agent 的全部内存状态
 *
 * 卸载时先注销监听、再 abort 生命周期信号（打断所有进行中的等待）、最后等待
 * 在途任务结算，避免热重载留下悬挂 Promise。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {unknown} rawConfig - `cordis.patch.yml` 里这一行声明的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (config.mode === 'off') {
    ctx.logger.info('model-auto-retry: mode=off，插件已停用（不注册任何监听）')
    return
  }

  /** 生命周期信号：卸载时 abort，用来打断所有进行中的等待。 */
  const lifetime = new AbortController()
  /** 每个 Agent 当前 step 的接管计数：agentId -> { turn, step, attempt }。 */
  const stepState = new Map()
  /** 待续跑的终结限流错误：sessionId -> { at, failure }。 */
  const pending = new Map()
  /** 续跑预算：agentId -> { count, since }。 */
  const budget = new Map()
  /** 在途任务集合，卸载时 drain。 */
  const active = new Set()

  const deps = { ctx, config, lifetime, stepState, pending, budget }

  /**
   * 登记一个在途任务；结算后自动从集合移除。
   * @param {Promise<unknown>} job - 在途任务。
   * @returns {Promise<unknown>} 同一个（已包装的）任务。
   */
  function track(job) {
    const tracked = job.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  const disposers = []

  // ── 第一层：请求期接管 ────────────────────────────────────────────────
  if (config.mode === 'hybrid' || config.mode === 'in-loop') {
    disposers.push(ctx.on('agent/request-error', (payload, next) => {
      if (lifetime.signal.aborted) return next()
      // catch 兜底：插件内部异常绝不能把宿主的 turn 一起带崩，出问题时退回「不处理」。
      return track(
        recoverInLoop(payload, next, deps).catch((error) => {
          ctx.logger.warn(`model-auto-retry: 请求期接管异常，放行原错误：${renderError(error)}`)
          return undefined
        }),
      )
    }))
  }

  // ── 第二层：中断后续跑 ────────────────────────────────────────────────
  if (config.mode === 'hybrid' || config.mode === 'continue') {
    disposers.push(ctx.on('session/event', (session, event) => {
      onTurnEnd(session, event, deps)
    }))
    disposers.push(ctx.on('agent/status', (payload) => {
      onIdle(payload, deps)
    }))
  }

  // ── 状态清理 ─────────────────────────────────────────────────────────
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined) return
    stepState.delete(agent.id)
    pending.delete(agent.id)
    budget.delete(agent.id)
  }))

  ctx.effect(() => async () => {
    // 先摘监听，避免卸载过程中还接收新事件。
    for (const dispose of disposers) dispose()
    // 再打断所有等待：sleep 的 abort 监听会立刻返回 false。
    lifetime.abort(new Error('model-auto-retry plugin disposed'))
    // 最后等在途任务结算，保证热重载不会留下悬挂 Promise。
    await Promise.allSettled([...active])
    stepState.clear()
    pending.clear()
    budget.clear()
  }, 'model-auto-retry: 卸载时中止等待并排空在途任务')

  ctx.logger.info(
    `model-auto-retry: 已激活（mode=${config.mode}, ` +
    `maxInLoopRetries=${config.maxInLoopRetries}, maxContinues=${config.maxContinues}）`,
  )
}
