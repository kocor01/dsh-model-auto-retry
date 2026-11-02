# dsh-model-auto-retry

让 DSH 的 Agent 在模型请求被限流（HTTP 429）时**不中断**，无人值守也能把长任务跑完。

- 第一层：请求失败后**原地重试**（不结束 turn），用 `Retry-After` / 指数退避等额度窗口过去。
- 第二层：如果重试确实用尽、Agent 已经中断，自动发送一条「继续」把任务接上。

两层都只在 **429 / `RATE_LIMIT`** 上生效；配额耗尽、鉴权失败等「重试也不会变好」的错误保持原样，
交给人工处理。

---

## 它到底做了什么

DSH 的内置重试（`@deepseek-ai/dsh-llm-retry`）把 `retryPolicy.maxRetries` 次跑完后，
`@deepseek-ai/dsh-agent-loop` 会把失败升级成终结错误：写 `turn/end { reason: { kind: 'error' } }`、
发 `agent/error`、Agent 回到 `idle`，任务停在半路。

本插件挂在同一个扩展点 `agent/request-error` 上，但**排在最后一层**：

```
请求失败
  └─ 内置 llm-retry：还能重试吗？能 → 它重试（我们完全不介入）
                     不能 → 轮到我们
  └─ 本插件第一层：是 429 吗？→ 等 Retry-After/退避 → 返回 { kind: 'retry' } → 循环原地重试
                     不是 429，或达到 maxInLoopRetries → 放行，让 turn 按原逻辑结束
  └─ 本插件第二层：turn 因 429 终结 → 等 Agent 变 idle → agent.followup('继续')
```

关键实现细节（改代码前请先读）：

1. **一定先 `await next()`。** 这样无论插件和 `llm-retry` 谁先加载，行为都一致：内置的快速重试优先，
   我们只负责「它放弃之后」。
2. **「继续」只能在 `idle` 时发。** `followup()` 在 `running` 阶段只会入队、不会唤醒驱动，消息会滞留到
   下一次用户输入。`turn/end` 一定先于 `agent/status(idle)` 提交，所以「先记录、后发送」是安全的。
3. **不写自定义 session 事件。** 宿主只接受带 `ignorable: true` 的未知事件，而 `Session.append()`
   设不了这个标记。所以插件的状态全在内存里，热重载后归零（等于重新拿到预算）。

---

## 安装

插件在仓库 https://github.com/kocor01/dsh-model-auto-retry 的 `package/` 子目录里，
所以从 GitHub 安装要用 pnpm 的 `#path:` 指定子目录。

### 一条命令直接装（推荐）

```powershell
dsh plugin --profile desktop add "github:kocor01/dsh-model-auto-retry#path:/package"
```

`dsh plugin` 把参数透传给 pnpm；`github:owner/repo#path:/子目录` 是 pnpm 官方的
[从 git 仓库子目录安装](https://pnpm.io/10.x/package-sources#install-from-a-subdirectory-of-a-git-repository)写法。
`desktop` 换成你的 profile 名。

私有仓库需要先配好 git 凭据（`gh auth login` + `gh auth setup-git`），或用 SSH 形式：

```powershell
dsh plugin --profile desktop add "git+ssh://git@github.com/kocor01/dsh-model-auto-retry.git#path:/package"
```

### 先克隆再装本地目录

离线环境、要改代码、或本机 git 凭据没配好时用这条：

```powershell
git clone https://github.com/kocor01/dsh-model-auto-retry.git
dsh plugin --profile desktop add ".\dsh-model-auto-retry\package"
```

这是本地目录安装：profile 里记的是指向 `<克隆目录>\package` 的链接，`git pull` 之后代码立刻是新的。

### 在 DSH 界面里装

`plugin_manager` → `install_bundle`，`target` 传克隆目录下 `package` 的**绝对路径**，
例如 `D:\code\dsh-model-auto-retry\package`。

### 装完确认

安装会在 profile 的 `bundle` 列表里加一行，并通过本包自带的 `cordis.patch.yml` 在 profile
根部插入插件行。确认它真的挂上了：`cordis_inspect_query` → host / `Config` / `listConfigs`，
传 `{"name": "@local/dsh-model-auto-retry"}`。该行 `status` 显示 `absent` 是正常的 ——
本插件不导出 `Config` schema（没有设置表单），不是没挂载。

注意 desktop profile 由 Electron 应用独占，`dsh --profile desktop --dump-config` 会报
`profile "desktop" is managed exclusively by the Electron application`，别用那条命令验证。

### 升级与卸载

```powershell
# 升级：方式 A 重跑 add；本地目录装的用 git pull。都需要重启 DSH 才会重新加载模块。
dsh plugin --profile desktop add "github:kocor01/dsh-model-auto-retry#path:/package"

# 卸载
dsh plugin --profile desktop remove @local/dsh-model-auto-retry
```

`plugin_manager` 的 `remove_bundle` 效果相同。

---

## 配置

改 `cordis.patch.yml` 里这一行的 `config`（或安装后用 profile patch 覆盖）。
所有键都可省略，下面是默认值：

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
    continueText: '继续'
    maxContinues: 8
    resetWindowMs: 1800000
    includeSubagents: true
    continueSource: 'user'
```

| 键 | 作用 | 什么时候改 |
| --- | --- | --- |
| `mode` | 恢复策略。`hybrid` 两层都开；`in-loop` 只原地重试（最安静）；`continue` 只做「继续」（最贴近人工行为）；`off` 关闭 | 想完全静默用 `in-loop`；想把「继续」留在聊天记录里当审计用 `continue` |
| `rateLimitCodes` / `rateLimitStatuses` / `messagePattern` | 三重 429 判定，命中任一即算 | 换了适配器、失败对象里没有 `code`/`status` 时 |
| `excludeCodes` | 永不自愈的错误类型 | 你更希望额度耗尽立刻停下时，把它加进来 |
| `respectRetryAfter` | 优先用服务端 `Retry-After` | 一般不用动 |
| `initialDelayMs` / `maxDelayMs` / `jitterRatio` | 退避曲线 | 额度是按分钟给的，调小；按小时给的，调大 `maxDelayMs` |
| `maxInLoopRetries` | 单 step 最多接管几次 | 配额很紧时调大；想快速失败调 0 |
| `continueText` | 注入的消息正文 | 换个说法，例如「请从中断处继续」 |
| `maxContinues` / `resetWindowMs` | 续跑预算（滑动窗口） | 防止持续限流时无限续跑 |
| `includeSubagents` | 子 Agent 是否也自愈 | 子 Agent 很多时关掉，避免并发放大 |
| `continueSource` | `user` = 普通用户气泡；`notice` = 提示条 | 不想让会话看起来像「人打的继续」时用 `notice` |

配置写错（未知键、类型不对、正则非法）会在**激活期**直接报错，不会有「装了但没生效」的静默状态。

---

## 你会看到什么

- `hybrid` / `in-loop`：聊天里**没有**额外消息，只有「这次请求慢了一点」。恢复过程写进宿主日志。
- `hybrid` / `continue`：中断后聊天里出现一条内容为「继续」的用户消息（或提示条），随后 Agent 继续干活。
- 放弃时（预算用尽 / 非 429）：行为和没装插件完全一样 —— 报错、停下、等人处理。

日志前缀统一是 `model-auto-retry:`，按它过滤即可：

```
model-auto-retry: agent "session-..." turn 1 step 1 命中限流（code=RATE_LIMIT, status=n/a），第 1/6 次原地重试，等待 5000ms
model-auto-retry: agent "session-..." 的 turn 因限流终结（code=RATE_LIMIT），登记一次自动续跑
model-auto-retry: agent "session-..." 已自动发送「继续」续跑
model-auto-retry: agent "session-..." 在 1800000ms 内已自动续跑 8 次，放弃续跑，保留错误等待人工处理
```

---

## 验证

### 单元测试

```powershell
node --check package\index.js
node test\unit.test.mjs
```

覆盖：配置校验、三重 429 判定、排除码、按 step 归零、达到上限放行、取消与卸载、两层联动、
inbox 抢跑、预算耗尽、Agent 销毁。

> 注意：在受限沙箱里 `node --test` 会因为子进程管道被拒绝而报 `spawn EPERM`，
> 直接 `node test/unit.test.mjs` 即可（`node:test` 在同进程内运行同一套用例）。

### 端到端（可复现，全程在本目录的隔离环境里，不碰真实 profile）

```powershell
# 1) 起假 429 服务：前 3 个请求返回 429，之后正常
node test/mock-429-server.mjs 8123 3

# 2) 用一个隔离的 DSH_HOME 装本插件，避免污染真实配置
$env:DSH_HOME = "D:\code\dsh-model-auto-retry\.e2e-home"
dsh plugin --profile headless add "D:\code\dsh-model-auto-retry\package"

# 3) 跑一次 headless 任务（overlay 把默认模型指向本地假服务，内置重试压到 1 次）
$env:MOCK_API_KEY = "test-key"
dsh headless --patch .e2e-home\overlay.yml "reply with the single word: ok"

# 4) 看会话日志：应当只有 completed，没有 error
node tools\read-session-log.mjs (Get-ChildItem .e2e-home\sessions -Recurse -File -Filter *.zstd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
```

对照组（同一个假服务、同一个 prompt，只把插件 `mode` 设成 `off`）：

```powershell
dsh headless --patch .e2e-home\overlay-control.yml "reply with the single word: ok"
# dsh: RATE_LIMIT: 429: {"message":"rps exhausted","type":"quota_exceeded_error","code":"8"}
```

本仓库实测结果：

| 场景 | 假服务 | 内置重试 | 结果 |
| --- | --- | --- | --- |
| `mode: off`（对照） | 3×429 | `maxRetries: 1` | `turn/end error`，CLI 退出码非 0，报 `RATE_LIMIT` |
| `mode: hybrid`（本插件） | 3×429 | `maxRetries: 1` | `turn/end completed`，输出 `done`，退出码 0 |

在插件开启的那次里，会话日志只有 **1 次** `llm/retry`（内置的）、**2 次** `assistant/attempt`，
而假服务一共收到 **4 个**请求 —— 第 4 个正是插件在内置重试耗尽后发出的原地重试。

---

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
package/            插件本体（Host-only bundle，零外部依赖）
  index.js          全部实现，带详细注释
  cordis.patch.yml  Loader 补丁：在 profile 根部插入一行
test/
  unit.test.mjs     单元测试（假 ctx，覆盖两层与全部分支）
  mock-429-server.mjs OpenAI 兼容的假 429 服务（端到端用）
tools/
  read-session-log.mjs 解压并统计会话日志（zstd 多帧），验证/排障用
docs/
  技术方案-dsh-model-auto-retry.md 设计与取舍
```
