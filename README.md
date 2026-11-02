# dsh-model-auto-retry

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Agent 在模型请求被限流（HTTP 429）时**不中断**，无人值守也能把长任务跑完。

> A DSH host plugin that keeps an agent alive through model rate limits: retries the failed request in place, then sends an automatic "如果任务未完成，请继续执行" follow-up if retries run out.

仓库根就是插件包（`package.json` / `index.js` / `cordis.patch.yml` 都在顶层），可以直接从 GitHub 安装。

## 解决什么问题

DSH 的内置重试（`@deepseek-ai/dsh-llm-retry`）把 provider 的 `maxRetries` 跑完后，`@deepseek-ai/dsh-agent-loop` 会把失败升级成终结错误：写 `turn/end { reason: { kind: 'error' } }`、发 `agent/error`、Agent 回到 `idle`。任务停在半路，必须人工再发一条消息才能恢复。

限额场景下这件事发生得很频繁 —— 实测某个会话里有 **744 次** `llm/retry`、**7 次** `turn/end` 为 error，全都是 429。

## 怎么解决：两层

```
请求失败
  └─ 内置 llm-retry：还能重试吗？能 → 它重试（本插件完全不介入）
                     不能 → 轮到本插件
  └─ 第一层：是 429 吗？→ 按 Retry-After / 指数退避等待 → 返回 { kind: 'retry' }
                         → 循环原地重试，Agent 不中断
  └─ 第二层：turn 因 429 终结 → 等 Agent 变 idle → agent.followup('如果任务未完成，请继续执行')
```

两层都只在 **429 / `RATE_LIMIT`** 上生效；配额耗尽、鉴权失败等「重试也不会变好」的错误保持原样，交人工处理。

三条实现上的硬约束（改代码前请先读 [index.js](index.js) 的模块注释）：

1. 一定先 `await next()`，让内置重试优先，本插件只当最后一层 —— 与加载顺序解耦。
2. 续跑消息只能在 `idle` 时发 —— `running` 阶段的 `followup` 只会入队，不会唤醒驱动，消息会滞留到下一次用户输入。
3. 不写自定义 session 事件 —— 宿主只接受带 `ignorable: true` 的未知事件，而存活的 `Session.append()` 设不了该标记。状态因此只放内存。

## 安装

### 从 npm 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-model-auto-retry
```

`dsh plugin` 把参数透传给 pnpm，所以 npm 上的包可以像普通依赖一样装。`desktop` 换成你的
profile 名（`dsh --help` 会列出可用 profile）。

### 一条命令从 GitHub 装

```powershell
dsh plugin --profile desktop add "github:kocor01/dsh-model-auto-retry"
```

仓库根有 `package.json`，不需要 `#path:` 之类的子目录语法。
**私有仓库**需要先配好 git 凭据（`gh auth login` + `gh auth setup-git`），或用 SSH 形式：

```powershell
dsh plugin --profile desktop add "git+ssh://git@github.com/kocor01/dsh-model-auto-retry.git"
```

### 先克隆再装本地目录

离线环境、要改代码、或本机 git 凭据没配好时用这条：

```powershell
git clone https://github.com/kocor01/dsh-model-auto-retry.git
dsh plugin --profile desktop add ".\dsh-model-auto-retry"
```

这是本地目录安装：profile 里记的是指向克隆目录的链接，`git pull` 之后代码立刻是新的。

### 在 DSH 界面里装

`plugin_manager` → `install_bundle`，`target` 传**仓库根目录**的绝对路径，例如
`D:\code\dsh-model-auto-retry`。

### 装完确认

安装会在 profile 的 `bundle` 列表里加一行，并通过包自带的 `cordis.patch.yml` 在 profile
根部插入插件行。确认它真的挂上了：`cordis_inspect_query` → host / `Config` / `listConfigs`，
传 `{"name": "dsh-model-auto-retry"}`。该行 `status` 显示 `absent` 是正常的 ——
本插件不导出 `Config` schema（没有设置表单），不是没挂载。

注意 desktop profile 由 Electron 应用独占，`dsh --profile desktop --dump-config` 会报
`profile "desktop" is managed exclusively by the Electron application`，别用那条命令验证。

### 升级与卸载

```powershell
# 升级：npm 装的用 update，GitHub 装的重跑 add，本地目录装的用 git pull。
# 三种方式都需要重启 DSH 才会重新加载模块。
dsh plugin --profile desktop update dsh-model-auto-retry

# 卸载
dsh plugin --profile desktop remove dsh-model-auto-retry
```

`plugin_manager` 的 `remove_bundle` 效果相同。

## 配置

改 profile 的 `cordis.patch.yml`（**不要**改仓库里那份，升级会被覆盖），按 id 覆盖：

```yaml
- id: model-auto-retry
  config:
    mode: hybrid              # hybrid | in-loop | continue | off
    rateLimitCodes: ['RATE_LIMIT']
    rateLimitStatuses: [429]
    messagePattern: '^\s*429\b'
    excludeCodes: ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED']
    respectRetryAfter: true
    initialDelayMs: 5000
    maxDelayMs: 300000
    jitterRatio: 0.2
    maxInLoopRetries: 6
    continueText: '如果任务未完成，请继续执行'
    maxContinues: 8
    resetWindowMs: 1800000
    includeSubagents: true
    continueSource: 'user'
```

上面就是全部默认值，每个键都可省略。覆盖时注意 Loader 的规则是**覆盖即替换整个 `config`**：
只写 `mode` 时其余键回落到代码里的默认值（本插件对每个键都补默认值，所以只写一个键是安全的）。

| 键 | 作用 | 什么时候改 |
| --- | --- | --- |
| `mode` | 恢复策略。`hybrid` 两层都开；`in-loop` 只原地重试（最安静）；`continue` 只做中断后续跑（最贴近人工行为）；`off` 关闭 | 想完全静默用 `in-loop`；想把自动续跑留在聊天记录里当审计用 `continue` |
| `rateLimitCodes` / `rateLimitStatuses` / `messagePattern` | 三重 429 判定，命中任一即算 | 换了适配器、失败对象里没有 `code`/`status` 时 |
| `excludeCodes` | 永不自愈的错误类型 | 你更希望额度耗尽立刻停下时，把它加进来 |
| `respectRetryAfter` | 优先用服务端 `Retry-After` | 一般不用动 |
| `initialDelayMs` / `maxDelayMs` / `jitterRatio` | 退避曲线 | 额度是按分钟给的，调小；按小时给的，调大 `maxDelayMs` |
| `maxInLoopRetries` | 单 step 最多接管几次 | 配额很紧时调大；想快速失败调 0 |
| `continueText` | 注入的消息正文，默认「如果任务未完成，请继续执行」 | 想更短就自行改写，想更明确就写清楚要在哪接着做 |
| `maxContinues` / `resetWindowMs` | 续跑预算（滑动窗口） | 防止持续限流时无限续跑 |
| `includeSubagents` | 子 Agent 是否也自愈 | 子 Agent 很多时关掉，避免并发放大 |
| `continueSource` | `user` = 普通用户气泡；`notice` = 提示条 | 不想让会话看起来像「人打的续跑消息」时用 `notice` |

配置写错（未知键、类型不对、正则非法）会在**激活期**直接报错，不会有「装了但没生效」的静默状态。

## 你会看到什么

- `hybrid` / `in-loop`：聊天里**没有**额外消息，只有「这次请求慢了一点」。恢复过程写进宿主日志。
- `hybrid` / `continue`：中断后聊天里出现一条内容为「如果任务未完成，请继续执行」的用户消息（或提示条），随后 Agent 继续干活。
- 放弃时（预算用尽 / 非 429）：行为和没装插件完全一样 —— 报错、停下、等人处理。

日志前缀统一是 `model-auto-retry:`，按它过滤即可：

```
model-auto-retry: agent "session-..." turn 1 step 1 命中限流（code=RATE_LIMIT, status=n/a），第 1/6 次原地重试，等待 5000ms
model-auto-retry: agent "session-..." 的 turn 因限流终结（code=RATE_LIMIT），登记一次自动续跑
model-auto-retry: agent "session-..." 已自动发送续跑消息「如果任务未完成，请继续执行」
model-auto-retry: agent "session-..." 在 1800000ms 内已自动续跑 8 次，放弃续跑，保留错误等待人工处理
```

## 验证

### 单元测试

```powershell
node --check index.js
node test/unit.test.mjs
```

28 个用例，覆盖：配置校验、三重 429 判定、排除码、按 step 归零、达到上限放行、取消与卸载、
两层联动、inbox 抢跑、预算耗尽、Agent 销毁。

> 注意：在受限沙箱里 `node --test` 会因为子进程管道被拒绝而报 `spawn EPERM`，
> 直接 `node test/unit.test.mjs` 即可（`node:test` 在同进程内运行同一套用例）。

### 端到端（可复现，全程在隔离的 DSH_HOME 里，不碰真实 profile）

```powershell
# 1) 起假 429 服务：前 3 个请求返回 429，之后正常（前台运行，另开终端做后面几步）
node test/mock-429-server.mjs 8123 3

# 2) 用一个隔离的 DSH_HOME 装本插件，避免污染真实配置
$env:DSH_HOME = "<repo>\.e2e-home"
$env:MOCK_API_KEY = "test-key"
dsh plugin --profile headless add "<repo>"

# 3) 跑一次 headless 任务（overlay 把默认模型指向本地假服务，内置重试压到 1 次）
dsh headless --patch test\e2e-overlay.yml "reply with the single word: ok"

# 4) 看会话日志：应当只有 completed，没有 error
node tools\read-session-log.mjs (Get-ChildItem .e2e-home\sessions -Recurse -File -Filter *.zstd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
```

另外两个覆盖层：

```powershell
# 对照组：同一个假服务、同一个 prompt，只把插件关掉 → 应当以 RATE_LIMIT 报错退出
dsh headless --patch test\e2e-overlay-control.yml "reply with the single word: ok"

# 只验证第二层：中断后注入续跑消息，不做原地重试
dsh headless --patch test\e2e-overlay-continue.yml "reply with the single word: ok"
```

> 假服务记得换端口或先确认 8123 空闲，否则 `node` 会以 `EADDRINUSE` 直接退出，
> 而残留的旧服务可能已经过了失败计数、全部返回 200，把结论带偏。

本仓库实测结果：

| 场景 | 假服务 | 内置重试 | 结果 |
| --- | --- | --- | --- |
| `mode: off`（对照） | 3×429 | `maxRetries: 1` | `turn/end error`，CLI 退出码非 0，报 `RATE_LIMIT` |
| `mode: hybrid` | 3×429 | `maxRetries: 1` | `turn/end completed`，输出 `done`，退出码 0 |
| `mode: continue` | 3×429 | `maxRetries: 1` | 先 `turn/end error`，随后注入「如果任务未完成，请继续执行」，新 turn `completed` |

`hybrid` 那次：会话日志只有 **1 次** `llm/retry`（内置的）、**2 次** `assistant/attempt`，
而假服务一共收到 **4 个**请求 —— 第 4 个正是插件在内置重试耗尽后发出的原地重试。

`continue` 那次：假服务同样收到 4 个请求（第 4 个来自续跑后的新 turn），
`USER PROMPTS` 是 `['reply with the single word: ok', '如果任务未完成，请继续执行']`。

## 已知边界

- 状态只在内存里：重启 DSH、热重载插件后重试预算归零。
- 不提供 UI：没有设置面板，也不在聊天里显示「等待中」。调参用 `cordis.patch.yml`。
- 不做主动限速：插件是「失败后恢复」，不是「提前排队」。真要压住 429，得配合 provider 的
  `retryPolicy` 或上游配额。
- `hybrid` 的最坏情况：每 step 最多 `maxInLoopRetries` 次原地重试 + 每窗口 `maxContinues` 次续跑，
  之后放行原错误 —— 不会静默死循环，也不会吞掉错误。
- 如果某个 provider 已经配置成 `retryPolicy.mode: always`，内置策略永不放弃，第一层自然不会触发；
  那种配置下也基本不会再需要本插件。

## 目录

```
package.json           插件清单（dsh.bundle.patch 指向 cordis.patch.yml）
index.js               全部实现，逐函数中文注释
cordis.patch.yml       Loader 补丁：在 profile 根部插入 model-auto-retry 行
icon.svg / locale/     插件列表里的图标与标题、描述（en / zh）
test/
  unit.test.mjs              单元测试（假 ctx，覆盖两层与全部分支）
  mock-429-server.mjs        OpenAI 兼容的假 429 服务
  e2e-overlay*.yml           端到端用的三个 Loader 覆盖层
tools/
  read-session-log.mjs       解压多帧 zstd 会话日志并统计事件
docs/
  技术方案-dsh-model-auto-retry.md  设计与取舍、实现与验证记录
```
