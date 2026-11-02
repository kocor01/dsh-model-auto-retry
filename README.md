# dsh-model-auto-retry

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Agent 在模型请求被限流（HTTP 429）时**不中断**，无人值守也能把长任务跑完。

> A DSH host plugin that keeps an agent alive through model rate limits: retries the failed request in place, then sends an automatic "如果任务未完成，请继续执行" follow-up if retries run out.

## 解决什么问题

DSH 的内置重试（`@deepseek-ai/dsh-llm-retry`）把 provider 的 `maxRetries` 跑完后，`@deepseek-ai/dsh-agent-loop` 会把失败升级成终结错误：写 `turn/end { reason: { kind: 'error' } }`、发 `agent/error`、Agent 回到 `idle`。任务停在半路，必须人工再打一句「继续」。

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

三条实现上的硬约束（改代码前请先读 [package/index.js](package/index.js) 的模块注释）：

1. 一定先 `await next()`，让内置重试优先，本插件只当最后一层 —— 与加载顺序解耦。
2. 「继续」只能在 `idle` 时发 —— `running` 阶段的 `followup` 只会入队，不会唤醒驱动。
3. 不写自定义 session 事件 —— 宿主只接受带 `ignorable: true` 的未知事件，而存活的 `Session.append()` 设不了该标记。状态因此只放内存。

## 安装

插件本体在仓库的 `package/` 子目录里（仓库根是文档与测试），所以从 GitHub 安装要用 pnpm 的
`#path:` 指定子目录。

### 方式 A：一条命令直接装（推荐）

```powershell
dsh plugin --profile desktop add "github:kocor01/dsh-model-auto-retry#path:/package"
```

`dsh plugin` 把参数透传给 pnpm；`github:owner/repo#path:/子目录` 是 pnpm 官方的
[从 git 仓库子目录安装](https://pnpm.io/10.x/package-sources#install-from-a-subdirectory-of-a-git-repository)写法。
`desktop` 换成你的 profile 名（`dsh --help` 会列出可用 profile）。

**私有仓库**：pnpm 用 git 克隆，需要先配好凭据。任选其一：

```powershell
gh auth login          # 然后让 git 复用 gh 的凭据
gh auth setup-git

# 或者直接用 SSH 形式
dsh plugin --profile desktop add "git+ssh://git@github.com/kocor01/dsh-model-auto-retry.git#path:/package"
```

### 方式 B：先克隆再装本地目录

离线环境、要改代码、或者本机 git 凭据没配好时用这条：

```powershell
git clone https://github.com/kocor01/dsh-model-auto-retry.git
dsh plugin --profile desktop add ".\dsh-model-auto-retry\package"
```

这是本地目录安装：profile 里记的是一个指向 `<克隆目录>\package` 的链接，`git pull` 之后代码立刻是新的。

### 方式 C：在 DSH 界面里装

`plugin_manager` → `install_bundle`，`target` 传克隆目录下 `package` 的**绝对路径**，例如
`D:\code\dsh-model-auto-retry\package`。

### 装完确认

安装会在 profile 的 `bundle` 列表里加一行，并通过包自带的 `package/cordis.patch.yml` 在 profile
根部插入插件行。确认它真的挂上了：

```
cordis_inspect_query → host / Config / listConfigs → {"name": "@local/dsh-model-auto-retry"}
```

该行 `status` 显示 `absent` 是正常的 —— 插件不导出 `Config` schema（没有设置表单），不是没挂载。

### 升级

```powershell
# 方式 A 装的：重跑同一条命令，pnpm 会重新解析 main 的最新提交
dsh plugin --profile desktop add "github:kocor01/dsh-model-auto-retry#path:/package"

# 方式 B/C 装的：拉代码即可（装的是目录链接）
git pull
```

两种方式都需要**重启 DSH** 才会重新加载模块 —— 运行中的进程持有的是激活时的 JS 版本。

### 卸载

`plugin_manager` 的 `remove_bundle`，或 `dsh plugin --profile desktop remove @local/dsh-model-auto-retry`。

## 配置

改 profile 的 `cordis.patch.yml`（**不要**改包内那份，重装会被覆盖）：

```yaml
- id: model-auto-retry
  config:
    mode: hybrid              # hybrid | in-loop | continue | off
    maxInLoopRetries: 6       # 第一层：每个 step 最多接管几次
    maxContinues: 8           # 第二层：单 Agent 每个窗口最多续跑几次
    resetWindowMs: 1800000    # 窗口长度（30min）
    continueText: '如果任务未完成，请继续执行'   # 第二层注入的消息正文
```

| mode | 行为 | 适合 |
| --- | --- | --- |
| `hybrid`（默认） | 先静默原地重试，预算用尽后自动发续跑消息 | 无人值守长任务 |
| `in-loop` | 只原地重试，永不注入消息 | 有人盯着、不想污染对话历史 |
| `continue` | 只做「中断后发继续」，每次恢复都留痕 | 需要审计「被自动救了几次」 |
| `off` | 全关，行为与未安装一致 | 应急止血 |

完整配置项与取舍见 [package/README.md](package/README.md)。

## 验证

```powershell
node --check package/index.js
node test/unit.test.mjs          # 27 个用例
```

单元测试 27/27 通过。端到端 A/B（隔离 `DSH_HOME`、本地假 429 服务、内置重试压到 1 次）：

| 场景 | 假服务 | 结果 |
| --- | --- | --- |
| `mode: off`（对照） | 3×429 后 200 | `turn/end error`，CLI 报 `RATE_LIMIT: 429 ...`，退出码非 0 |
| `mode: hybrid` | 同上 | `turn/end completed`，输出 `done`，退出码 0 |

开启的那次：假服务收到 4 个请求，会话日志里只有 1 次 `llm/retry`（内置的）、2 次 `assistant/attempt` —— 第 4 个请求正是内置重试耗尽后由插件补上的原地重试。

复现步骤见 [package/README.md](package/README.md#验证)。

## 目录

```
package/            插件本体（Host-only bundle，零外部依赖）
  index.js          全部实现，逐函数中文注释
  cordis.patch.yml  Loader 补丁
  README.md         安装 / 配置 / 验证 / 排障
test/
  unit.test.mjs           单元测试（假 ctx，覆盖两层与全部分支）
  mock-429-server.mjs     OpenAI 兼容的假 429 服务
tools/
  read-session-log.mjs    解压多帧 zstd 会话日志并统计事件
docs/
  技术方案-dsh-model-auto-retry.md  设计与取舍、实现与验证记录
```

## 已知边界

- 状态只在内存：重启 DSH 或热重载插件后重试预算归零。
- 无 UI：没有设置面板，也不显示「等待中」。调参走 `cordis.patch.yml`。
- 不做主动限速：是「失败后恢复」，不是「提前排队」。
- 若 provider 已配置 `retryPolicy.mode: always`，内置策略永不放弃，第一层自然不会触发。
