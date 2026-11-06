<p align="center">
  <img src="assets/hero.png" alt="发光的奇幻风景中，jeo-code 红色小龙虾魔法师与毛绒伙伴" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  基于 Bun 的 AI 编码代理 CLI — 需求访谈、经评审的计划、带门禁的执行、基于证据的检查。
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
  <a href="https://buymeacoffee.com/akillness3q"><img alt="通过 Buy Me a Coffee 赞助" src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-AC6415?style=flat-square&logo=buy-me-a-coffee"></a>
</p>

<p align="center">
  <img src="assets/character.gif" alt="动态 jeo-code 红色小龙虾吉祥物智能路由到最便宜的提供商并赚取金币" width="320" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>中文</b>
</p>

在仓库内运行 `jeo`，它会读取文件、编辑代码、执行命令，并把任务推进到完成 — 每一步都通过滚动友好的内联 TUI 实时呈现。

## 文档

- [双向消息网关（Discord、Telegram、Slack）](docs/integrations/messenger.md)

**消息网关** — `jeo messenger` 独立于通知守护进程，支持白名单内的 Discord、Telegram 和 Slack 会话。Discord 必须显式配置本地 Docker 沙箱；配置的工具在 Linux 客体中执行，不直接操作主机桌面或 shell。参见[消息网关指南](docs/integrations/messenger.md)及下文当前约束。

📖 **[使用指南](docs/usage-guide.md)** — 安装、TUI 操作（↑ 历史、Ctrl+O、`!` shell）、斜杠命令、`/resume`、规格优先工作流，附演示视频。

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> 无法内联播放？▶ [播放/下载演示视频](docs/jeo-code-promo.mp4)。

## 亮点

- **多提供商、单一循环** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio，以及 20+ 个 OpenAI、Anthropic 兼容云服务(Groq、DeepSeek、Mistral、OpenRouter、xAI、Kimi、z.ai 等)，统一在一个 JSON 工具循环中 — **还包括你自己注册的端点**: `jeo provider add --id my-proxy --base-url https://…`(或 `--preset litellm|vllm|sglang|azure-openai|…`)让 LiteLLM 代理、自托管 vLLM、企业内部 Anthropic 网关拥有各自的路由前缀、模型列表和凭据，而不是劫持内置的 `openai` 提供商。输入框内直接 OAuth 登录(`/provider login`)，每次模型选择都会持久化为新的默认值，而 prompt routing 只会自动选择真实可用的凭据路径: Gemini OAuth 会走 provider-qualified 的 `antigravity/*` 代理模型集，**以账号当前实际提供的为准**(实时发现 — 例如 Gemini 3.6 Flash 各档、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6；非对话模型与已弃用的 id 会被过滤掉，列表为空时也不会用静态目录顶替)，绝不选择需要 `GEMINI_API_KEY` 的 public `google/gemini-*` 行；如果已配置的路由指向尚未就绪的提供商，jeo 会先切换到同层级的等价凭据模型，再退回默认模型。
- **编辑完整性** — read 输出携带内容锚点(`42ab|`)；带锚点的编辑会与当前文件校验、行移动时自动重映射、不匹配时连同最新内容一起拒绝 — 绝不污染文件。
- **自我修正的验证循环** — 配置 post-edit 钩子(tsc / eslint / 测试)，代理会*亲自读取*诊断并在循环内修复；钩子未通过时 `done` 会被阻断。
- **真实门禁，不做表演** — `ralplan` 共识由真正读取仓库的 critic 子代理执行，`[OKAY]` 裁决被持久化且 `jeo approve` *强制要求*它；`ultragoal` 将套件运行作为全局信号，不伪造逐条通过。这不能证明测试运行器真实可信或工作区正确。
- **崩溃耐久、本地优先** — 全部状态位于 `.jeo/`，原子写入、跨进程运行锁、失败任务标记 + 恢复时的部分编辑警告。
- **动态步数预算** — 只要近期工具调用展现新的进展就持续延长，停滞时优雅收敛为总结；子代理保持精确的步数契约。
- **内联 TUI** — 已完成的工作流入真实滚动缓冲区(回合中也可用 tmux 滚轮)，代理运行时普通查询输入框仍保持可见并可编辑。Ctrl+O 详细信息切换、主题、剪贴板图片粘贴(Ctrl+V)、CJK/表情安全的宽度计算。
- **浏览器工具** — 基于 Playwright 的无头 Chromium 自动化,作为一等代理工具:对命名并复用的标签页执行 `open`/`close`/`run`/`act`,优先使用 `observe` 标记的元素 id 而非截图来驱动页面。`act {verb:"verify", goal, ...}` 闭合了可视化 QA 循环:对页面截图,并让一个独立的、具备视觉能力的模型依据一句大白话目标来判断(`{verdict:"PASS"|"MISMATCH", detail}`),不再需要人工(或同一个代理)去肉眼核对保存下来的 PNG。需要执行一次 `npx playwright install chromium`(未捆绑 — jeo 本身仍是零原生依赖,浏览器二进制文件是 Playwright 的独立下载项)。
- **持续积累的技能** — 卡壳的一轮现在会把死胡同写入同一个技能的项目级文件(`.jeo/skills/<name>.md`,首次写入时从内置技能播种,采用确定性关键词匹配,不使用 LLM),因此下一个会话的 `$<skill>` 调用会带上累积的"Known Failure Modes"/"Anti-Patterns"知识,而不是让内置文档永远保持静态。手动记录用 `jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"`;`jeo skills eval <skill>` 会运行一次真正的 LLM 判断,检查每条已记录的经验是否仍被技能当前的指引覆盖,还是已经过时。
- **低价位评分模型路由** — `/goal` 验证器、`critic` 子代理角色,以及未锁定的 `task` 扇出批次,现在默认使用低价位、已配置凭证的模型,而不是悄悄搭乘与它们所评分/执行的工作相同的全价模型(`resolveVerifierModel`,针对浏览器 `verify` 动作按视觉能力过滤,确保纯文本的低价模型不会悄悄丢弃附带的截图)。
- **`jeo routine init`** — 生成一个 GitHub Actions 工作流,在 schedule/issue/PR 触发器上以无头模式运行 jeo(`jeo "<prompt>" -p`),运行在 GitHub 自己的 runner 上 — 不需要笔记本电脑,并且不会给 jeo 自身增加任何新的攻击面(没有进程内调度器或 webhook 监听器)。`--dry-run` 可预览,`--no-pr` 则改为直接提交而非默认的每次运行一个 PR。
- **远程监控与控制(Telegram、Discord、Slack)** — 配对一次机器人(`jeo notify setup --provider telegram|discord|slack`)后，一个共享的 `jeo daemon start` 会在所有活跃会话中、子代理每次状态变化(启动 → 完成/失败/取消)时推送消息，并接受来自人类 allowlist 的 `/subagents`、`/steer`、`/cancel`(Discord/Slack 上还有 `/sessions` 和 `/send`)回传。Telegram 额外提供论坛主题、内联键盘和图片附件；Discord 使用 REST + Gateway WebSocket；Slack 使用 Web API + Socket Mode。附带各平台详细配置指南及可安装的 Agent Skill(`channel-notify`)。
- **有边界的工作流门禁，不是证明** — `approve` 会重新校验其批准的确切计划摘要，`team` 会拒绝审核后摘要已变化的计划。调用 `done` 时，当前回合的变更与验证信号可以阻止或降级完成；`/goal` 另加一次基于对话/工具历史的 LLM 判断和确定性证据门禁。两者都不会独立重新读取工作区；工具/测试输出是证据，并不能证明运行器或结果可信。这些检查也不保证回合结束后后台任务不会修改文件。`autopilot` ratchet 会将回滚失败记为 `rollback_failed` 并以非零状态停止。
- **不阻塞回合的会话级异步执行** — 通过 `task` 工具真实的 `tasks` 数组扇出独立工作，不阻塞父回合。detached 子代理、后台 job 和逐行 monitor 可在后续回合中继续使用 `subagent`/`job`/`monitor` 的 `list`、`inspect`、`await`、`cancel`、`tail` 控制。内联 TUI 为每个 worker 保留独立的实时 activity 槽位，并在会话退出或 Ctrl-C 时清理全部 registry。
- **计划 critic 门禁** — 计划不能跳过 architect/critic 步骤：`PlanSchema` 会拒绝以未验证变更结束的计划(变更之前的 verifier 不算)，并在 `ralplan` 起草阶段以及 `team`/`approve` 执行阶段生效。critic 裁决需要观察到仓库读取/搜索证据；这提高可审查性，但不等于独立验证工作区。
- **安全边界自动模型回退** — 未分类的安全拒绝(可能是分类器误报，而非真实的内容策略命中)现在会切换到真正不同提供商的模型，而不是在同一个模型上无限退让 — 与现有的 rate-limit 快速回退是同一套模式。`Refusal (<category>)` 这种形态的确定性拒绝不受影响，仍然零回退硬失败。
- **内存: 应得的信任** — 概念的验证日期现在只在蒸馏阶段被明确标记为已验证时才会写入，而不是每次写入都记录；`isConceptStale` 把未验证(或超过 30 天过期)的概念视为需要重新验证，而不是信任一个被动的时间戳。
- **动态工作流(`eval` 工具)** — 用 `task(role, taskText, context?)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`log(message)` 组合 JS 流程。没有会话沙箱时，Worker 线程超时不是安全边界。启用沙箱后 eval 在 Linux 客体中执行，不支持其中的 task/parallel/pipeline 委派辅助函数；请使用父进程的 `task` 工具委派。
- **在破损输出管道上安静退出** — 当管道输出到提前停止读取的命令时(`jeo --help | head`、消失的远程对端),不再转储原始的 `EPIPE` 堆栈 — 现在会以 shell 对被 SIGPIPE 终止的管道生产者报告的相同退出码(141)安静退出。真正的崩溃不受影响,仍会清晰地暴露出来。
- **macOS 低文件描述符上限警告** — 较低的 `ulimit -n`(BSD 默认 256/1024)可能导致文件监视、浏览器工具或大范围仓库扫描出现不明的 `EMFILE` 失败 — jeo 现在会在启动时警告一次(仅 stderr,绝不污染被管道的 `-p` 输出),并给出具体的 `ulimit`/`launchctl` 指引。可通过 `JEO_SKIP_NOFILE_CHECK=1` 选择退出。

## 安装

需要 Bun `1.3.14+`。

```bash
bun install -g jeo-code
jeo --version
```


## 快速开始

```bash
jeo                      # 在当前仓库启动交互式代理
jeo "整理 README 并跑测试"   # 单次请求
jeo doctor               # 配置 + 模型连通性实测
jeo setup                # API 密钥 / OAuth / 本地模型配置
jeo --tmux               # 在独立 tmux 会话中运行
```

## 斜杠命令

在 `jeo` REPL 中使用(Tab 补全，输入 `/` 打开面板)。

| 命令 | 说明 |
| --- | --- |
| `/model` · `/provider` | 选择模型/提供商；`/model` 在一个流程内显示默认/角色徽章、Ralph 风格嵌套的"设为角色"thinking 选择与 OpenAI Codex 角色预设 |
| `/provider login <name>` · `/logout` | 在输入框内 OAuth 登录/登出 |
| `/provider add` · `list` · `remove` · `presets` | 将 OpenAI/Anthropic 兼容端点注册为一等提供商(15 个网关预设) |
| `/agents [role]` · `/subagent` | 按角色(executor/planner/architect/critic)配置模型·thinking·步数 |
| `/thinking [level]` | 查看/设置默认推理预算(low…xhigh) |
| `/route [status\|on\|off\|why\|history [n]]` | 切换本会话基于提示词的模型路由 · 解释最近一次路由决策 · `history [n]` 列出本会话最近 n 条(默认 10 条)路由决策(每轮自动路由到与层级匹配的模型，且只在你已配置的凭证 — OAuth 或 API 密钥 — 实际可用的模型中选择；已配置的路由未就绪时会切换到同层级的等价模型) |
| `/fast [on\|off\|status]` | 当前模型支持 low 推理时切换 fast thinking 模式 |
| `/skill` · `$<skill> [intent]` | 列出/运行工作流技能(`$team "任务"` 风格) |
| `/view` · `/diff` · `/find` · `/search` | 代码查看、git diff、文件/模式搜索 |
| `/computer [status\|on\|off]` | 切换本会话的 fail-closed 桌面自动化工具 |
| `/new` · `/sessions` | 开始新会话或列出已保存会话 |
| `/resume [id\|gajae:<session-id>[#<leaf>]] [--any-cwd]` | 恢复 Jeo 会话，或将只读的精确版本 GJC v5 分支导入新的 Jeo 会话 |
| `/changelog [--full]` · `/jobs [list\|tail\|await\|cancel]` | 显示发布说明 · 查看、等待或取消当前会话的后台任务 |
| `/history [n\|all]` · `/export` | 将可读的工作活动历史重新输出到滚动区 · 导出记录 |
| `/retry` · `/btw <q>` | 重试上次请求 · 不写入历史的旁路提问 |
| `/usage` · `/context` · `/compact` | Token 用量、上下文明细、手动压缩 |
| `/theme` · `/config` · `/help` | 主题、运行时配置、帮助 |

> [!CAUTION]
> **通过 `/model <name>` 手动指定模型后，路由会在本会话内保持锁定。** Prompt routing(`/route`)只在没有手动锁定模型时才会逐轮重新评估。用 `/model <name>` 选定具体模型后，该选择会被锁定 — 直到你运行 `/model auto`(彻底解除锁定)，或运行 `/route on`(不会清除锁定，只是优先级更高 — 一旦运行 `/route off`，锁定会立刻恢复)之前，路由都不会再切换。未配置 `roles.*` 条目时，只有 `standard` 层级会确定性地退回到 `defaultModel`；`high`/`complex` 层级通常会先实时扫描已配置凭证中最强的可用模型再决定是否回退，所以即使未配置，也可能每轮落到不同的模型上。**例外:** 通过 Antigravity 或 Gemini OAuth 授权的会话会用同一个凭证重新导出 Anthropic/Google/OpenAI 的模型 —此时 `high`/`complex` 会按公司各选一个模型、以会话为单位稳定分布(不一定是最强的那个)，因此在同一会话内保持固定，而不是逐轮变化。

### Antigravity 账户模型与官方 agy 桥接

**Cloud Code Assist (`antigravity/<CCA-id>`)** — `/model provider antigravity` 与 `/agents <角色> provider antigravity` 显示 Cloud Code Assist 为所选 jeo OAuth 账户返回的模型。发现过程合并 `agentModelSorts`、`tieredModelIds` 和 `defaultAgentModelId`，账户级缓存在刷新后仍保持隔离。空列表或发现失败会如实报告，不会退回静态目录。CLI 模型 slug 不是 CCA 的通信 ID，CLI 中可用也不代表支持通过 CCA 直接调用 Argon。

**CCA 示例：** `jeo auth login antigravity` 会发现并缓存该账户的模型。通过 `/model antigravity/<CCA-id>` 或 `/agents executor provider antigravity` 选择，或通过 `/model save antigravity/<CCA-id>` 保存默认值。

**官方 CLI (`agy/<official-cli-slug>`)** — 显式选择一个独立的完整代理后端，使用已安装在 `PATH` 上的 `agy` 可执行文件。认证通过官方 CLI 自身支持的流程管理；jeo 不管理或导入其凭证。`agy models` 提供真实列表和准确的 slug，不使用静态目录或 CCA 别名。不能假定 CLI 会话、账户与 jeo OAuth 账户相同；CLI 模型列表仅保存在当前进程内，不使用 jeo 的账户级磁盘缓存。空列表保持为空，发现失败则显示错误，不会编造模型。

```sh
agy models
jeo launch --model agy/gemini-4-argon-low --plan --no-tui --no-session --no-skills "Explain this repository"
```

请使用自己的 CLI 实际返回的 slug。在交互式 jeo 会话中查看列表、选择模型，并按需保存为持久默认值：

```text
/model provider agy
/model agy/gemini-4-argon-low
/model save agy/gemini-4-argon-low
```

> [!WARNING]
> **官方 agy 代理自行管理工具、沙箱、权限和对话。jeo 的审批不介入其内部工具调用。** `--plan` 只选择 CLI 的计划模式，不会将工具审批权交给 jeo。此桥接必须显式选择，仅支持文本，不参与自动原始模型或子代理路由；图片附件以及无法强制执行的 jeo 专用工具、系统、步骤数、thinking 控制会被拒绝。

启用 jeo 会话持久化时，恢复会使用该会话保存的 CLI 对话 ID，而不是 CLI 中无关的最近对话。取消和有界超时会停止 CLI 轮次。准确保留所选模型及上游 CLI 错误，包括配额错误；不会静默回退到 CCA、其他模型或其他账户。

## CLI 命令

`jeo --help` 是权威列表；下面是你最常用到的:

| 命令 | 用途 |
| --- | --- |
| `jeo [prompt] [--resume [id]] [--tmux] [--worktree <path>] [-p] [-q]` | 交互式代理(默认)；`-p`/`--print` 用于无头单次输出，`--worktree` 用于隔离的同级检出 |
| `jeo setup` · `jeo auth login\|logout\|refresh\|status [provider]` · `jeo doctor` | 提供商、自动刷新的 OAuth(PKCE)令牌、实时连通性 + 过期模型锁定检查 |
| `jeo provider list\|add\|remove\|presets\|test` | 具名的自定义 OpenAI/Anthropic 兼容提供商(与 `/provider` 共用同一套 planner) |
| `jeo deep-interview` → `ralplan` → `approve` → `team` → `ultragoal` | Spec-first 工作流(见下文)；`jeo state <skill> read\|write\|clear\|handoff` 用于检查回执 |
| `jeo notify setup\|status\|health\|test` · `jeo daemon start\|stop\|status\|reload` | Telegram / Discord / Slack 通知与共享控制守护进程 |
| `jeo autopilot <subcommand>` · `jeo ledger <subcommand>` | 带分数 ratchet 的自主构建循环(`status` 显示方向、keep/revert 次数和下一步动作) · 跨计划的只追加账本 |
| `jeo routine init …` | 生成一个 GitHub Actions 工作流，按计划或仓库事件以无头模式运行 jeo |
| `jeo skills list\|read\|sync\|lesson\|eval` | 内置、用户和项目技能；漂移检查；已记录的经验 |
| `jeo mcp serve\|tools` · `jeo computer <action>` | 供外部控制器使用的 MCP stdio 服务器 · 桌面自动化动作 |
| `jeo session list\|attach\|rm` · `jeo export [id]` · `jeo chat "<msg>"` | tmux 会话管理 · 导出记录 · 无工具的流式聊天 |
| `jeo update [--check]` · `jeo whats-new` · `jeo memory-migrate` | 从 npm 自更新 · 内置发布说明 · 旧版 `MEMORY.md` → OKF 概念包 |

## Spec-first 工作流

需求 → 计划 → 批准 → 执行 → 验证由 `.jeo/state/` 管理。各阶段门禁可以阻止相应流程，但不保证每次交接或最终完成结果都正确。

```bash
jeo deep-interview "描述你想构建的东西"
jeo ralplan
jeo approve <计划路径>
jeo team
jeo ultragoal
```
![Interview → reviewed plan → approval → execution → verification](assets/workflow.svg)

```
  ┌──────────────────────┐
  │   deep-interview     │  Socratic ambiguity gate · seed frozen when concrete
  └──────────┬───────────┘
             │ .jeo/state/<seed>.json
             ▼
  ┌──────────────────────┐
  │       ralplan        │  Draft + repo-grounded critic → [OKAY] persisted
  └──────────┬───────────┘
             │ requires [OKAY] verdict
             ▼
  ┌──────────────────────┐
  │       approve        │  Schema + roles + [OKAY] — unlocks execution
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │        team          │  Serial executor · run lock · mutation audit
  └──────────┬───────────┘
             │ all tasks done
             ▼
  ┌──────────────────────┐
  │      ultragoal       │  基于证据的报告 — 套件运行一次，不伪造逐项通过
  └──────────────────────┘
```

- **deep-interview** — 基于歧义度评分的苏格拉底循环；只有标准足够具体才冻结种子(纯含糊标准会被拒绝)，且种子必须通过自身解析器的往返校验。新想法绝不会静默复用已完成的访谈。
- **ralplan** — 起草阶段 + **真正读取仓库的 critic 子代理门禁**: 强制并持久化 `[OKAY]`/`[ITERATE]`/`[REJECT]` 裁决。无效计划(schema、未知角色)不会被标记为 complete。
- **approve** — 校验 `team` 执行的确切契约(schema+角色)，并要求持久化的 `[OKAY]` 共识裁决。
- **team** — 在跨进程运行锁下执行已审阅的步骤。具有相同 `parallel_group` 的连续步骤在独立 Git worktree 中并行执行并按顺序合并；任务契约、变更审计和失败标记会暴露未完成的工作。
- **ultragoal** — 基于证据的报告：套件运行一次作为全局信号，不伪造逐项通过。这不能证明测试运行器真实可信或工作区满足目标。

`/goal` 会通过单独的 LLM 调用判断对话和已记录的工具历史，并对当前回合的修改与新验证信号应用确定性门禁。它不会重新读取工作区，也不会验证测试输出是否真实；launch 完成门禁也不检查仍在运行的后台任务。

## 验证钩子(自我修正)

先全局启用一次(在 `~/.jeo/config.json` 中设置 `"hooks": { "enabled": true }`)，再为项目添加 post-edit 检查，代理会读取失败并在 `done` 之前修复:

```jsonc
// .jeo/hooks.json
{
  "enabled": true,
  "hooks": [
    { "event": "post-turn", "match": { "tool": "edit|write" }, "run": "bun x tsc --noEmit" }
  ]
}
```

非零退出钩子的输出会附加到模型读取的工具结果中(批内去重)；钩子未通过就调用 `done` 会收到带钩子名称的回推。

### 提示与回合钩子,以及用户注册表

除工具循环事件外,每个回合还会触发两个事件:

| 事件 | 时机 | 载荷(stdin JSON) | 钩子输出 |
| ---- | ---- | ---------------- | -------- |
| `pre-prompt` | 模型看到所输入提示之前 | `{event, hook_event_name: "UserPromptSubmit", session_id, cwd, prompt}` | stdout 文本,或 JSON 的 `hookSpecificOutput.additionalContext` / `additionalContext` / `context`,会以 `[pre-prompt hook context]` 块的形式追加到提示消息末尾(提示卡片和历史标题只保留你自己的话) |
| `turn-end` | 最终回复之后 | `{event, hook_event_name: "Stop", session_id, cwd, prompt, response, last_assistant_message, done, steps, model}` | 忽略 |

两者都是建议性的:非零退出、超时或中止只会打印通知,绝不阻止提示(默认超时 10 秒 / 30 秒)。`$skill` 运行和消息机器人 literal 会话会跳过它们;`agy/` 模型因官方 CLI 自行管理提示而跳过 `pre-prompt`,但仍运行 `turn-end`。`pre-tool` 钩子也可以 exit 0 并输出 `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}` 来否决(`ask` 视为 deny),或输出 `additionalContext` 追加到该工具的结果;普通 stdout 仍被忽略。所有载荷还带有 `hook_event_name`、`session_id` 和 `cwd`(工具事件另有 `tool_name`/`tool_input`),因此 Claude Code / Codex 的钩子脚本无需修改即可运行 —— 仅限主机会话;沙箱内的钩子收到旧版载荷。

**用户注册表。** `~/.jeo/hooks.json`(与 `.jeo/hooks.json` 格式相同,遵循 `JEO_CONFIG_DIR`)是供代你安装钩子的工具(如 jeo-skills 的提示路由和知识管道)使用的仅含钩子的文件,与 `config.json` 分离,因此凭据不会被重写。优先级:`config.json` 中的 `"hooks": { "enabled": false }` 会禁用一切;项目 `.jeo/hooks.json` 中的 `"enabled": false` 仅让该项目退出;否则注册表无需 `hooks.enabled: true` 即可运行,并排在已配置钩子之前。项目自己的 `hooks` 列表仍然只替换 `config.json` 的列表,绝不替换注册表,且项目 / `config.json` 钩子仍然只在 `hooks.enabled: true` 时运行。沙箱会话会跳过注册表。

`jeo doctor` 会用 `[hooks]` 行(`--json` 中为 `hooks`)显示当前实际运行的钩子,并在注册表/项目文件无法读取、条目因无效被忽略,或全局开关/项目退出让所有钩子失效时发出警告。

## 内存流程

`jeo` 在 `.jeo/memory/` 下保存 **本地优先、蒸馏后的项目内存**(无远程后端,零原生依赖)。过往会话被蒸馏为 [OKF](docs/okf_mem/) 概念包,下一次会话仅把相关的、受预算约束的切片重新注入系统提示 —— 作为 DATA 而非指令加固。用 `JEO_NO_MEMORY=1` 完全禁用。

**迁移(`jeo memory-migrate`,一次性 · 幂等).** 把旧版单文档 `MEMORY.md` 无损转换为概念包: `## 标题 → 类型`,每个项目符号 → 一个类型化概念,缩进行 → 正文; 重建 `index.md`/`log.md`,并把原文件重命名为 `MEMORY.md.bak`。一旦概念包中已有概念,再次运行即为 no-op。**回滚:** `JEO_MEMORY_LEGACY=1` 忽略概念包,通过相同的注入加固读取 `MEMORY.md`/`.bak`(`JEO_NO_MEMORY=1` 仍优先于一切)。
## 与您现有的代理或机器人协同工作 (Works beside your existing agent or bot)

| 工具或机器人 | 推荐的 jeo 命令 | 边界 |
| ----------- | ----------------------- | -------- |
| Codex CLI | `jeo --tmux --worktree <name>` 或 `jeo` | `--worktree` 指定一个由 jeo 管理的同级 git worktree（basename → 新分支）；对于已有路径，请先 `cd` 进入。 |
| Claude Code | `jeo --tmux` 或 `jeo --tmux --worktree <name>` | jeo 不会成为 Claude Code 的扩展。 |
| OpenCode | `jeo` 或 `jeo --tmux` | 仅限外部运行器工作流。 |
| Claw Code | `jeo --tmux --worktree <name>` | jeo 不会安装到或替换 Claw Code。 |
| 外部控制器 / 机器人 | `jeo mcp serve` (MCP stdio 服务器) | 外部控制器通过 MCP 工具契约驱动 jeo，而非抓取滚动回显。 |

`--worktree <name>` 在隔离的同级 git worktree 中运行 jeo（路径存在则复用，否则以 basename 分支创建），因此有风险或需审查的工作绝不会触及您的主检出。`jeo mcp serve` 通过 stdio 向任何支持 MCP 的控制器公开 jeo 的工具（用 `jeo mcp tools` 列出）。添加 `-q`/`--quiet`（或 `JEO_QUIET=1`）可抑制启动横幅、欢迎动画、发布说明和恢复提示，使 jeo 能够与其他代理并行运行或由机器人驱动。`-p`/`--print` 隐含 quiet。

## 远程监控与控制 (Telegram, Discord & Slack)

可选功能: 一个共享守护进程监视本机上所有活跃的 `jeo` 会话，并在每次**子代理状态变化**(启动 → 完成/失败/取消)时推送消息，另附会话身份头、回合开始/结束摘要以及最终的回合文本 — 绝不会重复"仍在运行"之类的通知。allowlist 中的人类可以在聊天里列出、发送、引导和取消；每一条控制都会转发给本地会话，并报告为**已确认(已接受，未必已完成)**或**未确认** — 守护进程绝不声称某条命令已执行。

### Discord 会话与沙箱边界

一个 Discord 线程保留一个持久会话，不因发送者或消息而改变。同线程请求按 FIFO 执行，其他会话可并发。会话共享所选工作区，不创建每会话 Git worktree，因此文件修改可能冲突。

在消息网关配置中设置 `sandbox`；在 `~/.jeo/config.json` 中采用相同格式可隔离终端会话：

```json
{
  "sandbox": {
    "image": "oven/bun:1.3.14",
    "limits": { "memoryBytes": 268435456, "pids": 64, "cpus": 1 }
  }
}
```

这只是沙箱部分，不是完整的消息网关配置；请保留现有 `platforms` 白名单及凭据环境变量名。Linux Bun 镜像必须已存在于本地 Docker 守护进程。后端解析其不可变镜像 ID，使用 `--pull=never`，不会拉取镜像、安装依赖、使用远程 Docker 或回退到主机执行。即使主机是 Mac/Windows，运行的仍是 **Linux 客体 shell**，不是主机原生 shell。网络为 `none`；`/workspace` 可读写，额外路径需要会话级 `ro`/`rw` 授权。整个主目录、私有控制路径及控制 socket 均不可授权。主机操作者和 Docker 守护进程仍属于可信边界。

只有直接提交给父进程的人类控制才能决定授权：`/sandbox status`、`/sandbox approve <requestId>`、`/sandbox deny <requestId>`、`/sandbox revoke`。模型的 `sandbox_request {host, mode:'ro'|'rw'}` 仅能申请，不能自批。决定要求已认证操作者自己的会话及当前请求 revision，过期或跨会话请求会被拒绝。现有终端 Discord 远程控制也必须使用沙箱：本地 `/discord control on --allow-full-control` 开启，`/discord control off` 关闭；远程轮次保留本地输入草稿。

运行时拒绝 `independentSessions`，显式执行 `jeo messenger setup` 迁移才会移除该项。`sessionDir` 必须是工作区外、与之不重叠的私有路径。工作区中的旧 `.jeo/sessions`、`.jeo/messenger-sessions`、`.jeo/memory/raw` 会话与原始记录存储会阻止启动并给出移动指引；重启前须主动迁移，不会自动复制或删除。完整对话历史只留在父进程专用存储，蒸馏后的项目学习共享。复用现有 ECC 技能/工作流安装，未进行全局重装；受保护的全局技能在执行前保存快照，工作区/获准文档通过客体读取。

**验证范围（2026-11-03）：** 实际的 macOS 真实 Docker 验证器（`bun run verify:sandbox`）通过 **20 项行为契约**，源码独立构建也已通过。复制出的独立二进制通过了范围有限的验证，涵盖真实 PTY FIFO、父进程 `sandbox_request` 与真实 Linux 客体工具、完整历史隐私、与父进程生成的 stderr 关闭 nonce 匹配的 ACK、真实 worker 退出（143）以及 Docker 容器不存在。当前源码包装层保留 teardown 清理所有者、有界的关闭等待、人类按会话授权、一个持久线程/FIFO 以及共享工作区。这不是完整测试套件、跨平台或生产环境的验证：完整 `bun test` 超时，**未通过**；通用聚焦套件仍有陈旧 fixture 失败，正在修复。原生 Linux 和 Windows 主机验证暂不可用，也未实际向 Discord 发送消息。macOS 上的 Linux 客体不等于主机认证。`bun run build:hands` 构建 worker；`bun run verify:sandbox` 运行真实 Docker 检查，不安装前置依赖。必须确认 worker/容器已清理，错误或未确认移除不能报告成功。

各平台详细独立指南：
- 📖 [渠道集成概览与架构](docs/integrations/README.md) — 功能对比矩阵与架构图
- 📱 [Telegram 集成指南](docs/integrations/telegram.md) — 内置后台守护进程、BotFather 交互配对、论坛主题与 `/steer` 命令
- 🎮 [Discord 集成指南](docs/integrations/discord.md) — 即时频道通知 Webhook、双向交互机器人与 Embed 卡片规范
- 💬 [Slack 集成指南](docs/integrations/slack.md) — 工作区通知 Incoming Webhook、团队协作 Slack App / Socket Mode 与 Block Kit 卡片
- 🧩 [Agent Skill 安装指南](docs/integrations/agent-skills.md) — 将渠道通知技能一键安装至 `jeo`、Claude Code、Cursor、Codex 等环境

```bash
jeo notify setup  [--provider telegram|discord|slack] [--token-env NAME] [--app-token-env NAME] [--chat-id ID | --channel-id ID] [--allowed-user-ids ID,ID,...]
jeo notify status [--provider …]   # masked token, destination, allowlist, daemon state (stopped / stale / initializing / initialized / pairing)
jeo notify health [--provider …]   # read-only: bot identity + destination access, nothing sent
jeo notify test   [--provider …]   # sends one real test message
jeo daemon start|stop|status|reload   # the shared daemon has no provider selector
```

| | Telegram(默认) | Discord | Slack |
| --- | --- | --- | --- |
| 凭证 | 机器人 token(`JEO_TELEGRAM_BOT_TOKEN` 或 `--token-env`) | 机器人 token(`JEO_DISCORD_BOT_TOKEN` 或 `--token-env`)+ **Message Content** intent | 机器人 `xoxb` token(`JEO_SLACK_BOT_TOKEN` 或 `--token-env`)+ 应用 `xapp` token(`SLACK_APP_TOKEN` 或 `--app-token-env`)，并启用 Socket Mode |
| 目标 | 通过挑战配对的私聊(在 120 秒内把显示的 `/start jeo_<code>` 发给机器人)或显式 `--chat-id`；群组需要 `--allowed-user-ids` | 显式 `--channel-id`(文字频道、DM、公告频道或已有线程) | 机器人已加入的显式 `--channel-id`(`C…`)；工作区固定为 token 所属的团队 |
| Allowlist | 私聊可选，群组必需 | 必需(人类用户 ID；机器人会被忽略) | 必需(人类用户 ID) |
| 传输 | 直接调用 Bot API `getUpdates` 长轮询，每个机器人 token 只有一个轮询所有者 | 发送走 REST，入站走 Gateway WebSocket | 发送走 Web API，入站走 Socket Mode WebSocket |
| 附加能力 | 论坛主题、内联取消按钮、图片附件、可选的每会话主题(`notifications.telegram.perSessionTopics`，仅限开启 Threaded Mode 的私聊) | 回复某条会话通知即可向该会话发送文本(24 小时内) | 在会话通知的线程中回复即可向该会话发送文本(24 小时内)；已注册的 Slack 斜杠命令或 `@bot /command` 均可用 |
| 命令 | `/subagents` `/steer <session> <subagent> <msg>` `/cancel <session> <subagent>` `/help` | `/sessions` `/subagents` `/send <session> <text>` `/steer …` `/cancel …` `/help` | 与 Discord 相同 |

这些词不可互换，所以说明一下它们各自的含义:

- **Setup** 会通过官方 API 验证机器人身份和目标访问权限(Telegram `getMe`，Discord 机器人 + 频道查询，Slack `auth.test`/`bots.info`/`conversations.info` 以及一个 Socket Mode URL)，并把结果存入 `~/.jeo/config.json` 的 `notifications.<provider>` 下 — **明文**；请保持该文件私有。它不会发送消息，也不会打开 socket。
- **`initialized`**(`jeo daemon status`)表示守护进程已持有自己的锁并启动了各传输层；它并不证明 Telegram 轮询、Discord Gateway 握手或 Slack Socket Mode 连接已经成功。要验证这些请使用 `notify health` / `notify test`。
- **更改 token 或目标**会重置 Discord 和 Slack 的 allowlist(你必须再次传入 `--allowed-user-ids`)以及 Telegram 的每会话主题映射；用完全相同的凭证和目标重新运行 setup 则会保留它们。
- **远程命令是字面文本**(`/subagents` 等)，仅对配置的聊天/频道及白名单授权；Slack 也接受同名注册斜杠命令。Discord 终端控制默认关闭，须在沙箱会话中本地提交 `/discord control on --allow-full-control` 开启，`/discord control off` 撤销。遵守上文沙箱和人类授权边界，不要在聊天中放入凭据。
- **重试按提供商有界**: Telegram 遵守 429 的 `retry_after` 冷却(限制在 1 秒–1 小时之间)并使用独立的轮询退避；Discord 和 Slack 在 429 时按服务器的 `Retry-After` 最多重试 3 次，且绝不重发结果未知的 POST(平台可能已经收到了它)。
- **孤儿恢复**: 守护进程崩溃后，其锁会变为 `stale`；下一次 `jeo daemon start` 会回收它。当宿主机能够报告进程启动时间时，`jeo daemon stop` 会拒绝向已被复用的 PID 发送信号；无法报告时也会明确说明。
- **目前已验证**: Telegram 端到端(真实发送、轮询、干净关闭)。Discord 和 Slack 基于同一个守护进程实现，配有离线的传输/接线测试以及代码、安全和类型审查；尚未用真实的机器人/应用凭证进行实际连通性验证。

```
┌─────────────────────┐        ┌──────────────────┐        ┌───────────────────────────┐
│   interactive turn  │◄──ws──►│  notify daemon   │◄──────►│ Telegram Bot API (poll)   │
│  SubagentRegistry   │  (one  │   (singleton)    │        │ Discord REST + Gateway WS │
│  session endpoint   │  per   │                  │        │ Slack Web API + Socket WS │
└─────────────────────┘ session└──────────────────┘        └───────────────────────────┘
```

### Discord & Slack (Webhook 与 Bot App)

为团队工作区配置标准 Webhook 或 Bot 凭证环境变量：

```bash
# Discord Webhook
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Slack Incoming Webhook
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

支持发送包含任务状态、耗时、Git 提交与 PR 链接的富文本 Embed(Discord) 及 Block Kit 卡片(Slack)。详见 [Discord 指南](docs/integrations/discord.md) 与 [Slack 指南](docs/integrations/slack.md)。

### 安装为 Agent Skill

使用标准的 [Agent Skills](https://agentskills.io) CLI，可将渠道通知技能快速安装到 `jeo` 或其它 AI 编码代理中：

```bash
# 安装 channel-notify 技能到当前仓库：
npx skills add akillness/jeo-code --skill channel-notify

# 或全局(-g)安装，供所有项目使用：
npx skills add akillness/jeo-code --skill channel-notify -g
```

安装后，代理可在执行任务时自主发送进度通知：
```bash
# 在 jeo 中单次调用：
jeo $channel-notify "所有 47 个测试均已通过，等待代码审查。"

# 在 Claude Code 中调用：
/channel-notify "构建成功。PR 链接: https://github.com/..."
```

## 例行任务 (GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

生成 GitHub Actions 工作流(`.github/workflows/<name>.yml`)，在 GitHub 托管 runner 上安装 jeo，并按 `schedule` / `issues` / `pull_request` 无头执行(`jeo "<prompt>" -p`)，同时提供手动执行的 `workflow_dispatch`。GitHub 负责触发；例行任务不增加进程内调度器或 webhook 监听器。会话沙箱是需要上述本地前置条件的独立显式配置，不由工作流生成器安装。默认对变更创建 PR(`peter-evans/create-pull-request`，空 diff 为 no-op)；`--no-pr` 则提交到触发分支。`--dry-run` 仅输出 YAML，覆盖已有 `--out` 须加 `--force`。首次实际运行前设置仓库 secret `ANTHROPIC_API_KEY`（或 `--api-key-env <VAR>`）。

## 本地模型

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 配置

- 全局配置: `~/.jeo/config.json`(模型选择 MRU 持久化)
- 项目状态：`<project>/.jeo/`；沙箱会话记录保留在工作区外（参见上文 Discord 会话边界）。

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...           # 例: ollama/qwen2.5:0.5b
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura/gruvbox-dark
JEO_TUI_ALT_SCREEN=1            # 旧版 alt-screen 回合(默认: 内联滚动缓冲)
JEO_STEP_BASE=24                # 动态步数预算的滚动基数
JEO_STEP_HARD_CAP=600           # 绝对终止保证
JEO_STREAM_MAX_MS=1800000       # 整体流截止(默认30分钟; 约束 slow-drip 流，不是为了中断仍在活跃输出的流); 0 表示禁用
JEO_STREAM_IDLE_MS=300000       # 单次分块空闲上限(默认300秒); 首个 token 前静默较久的慢速/本地后端可调高
JEO_CALL_TIMEOUT_MS=1800000     # 非流式调用墙钟上限(默认30分钟; compaction/subagents/goal-verify)
JEO_TURN_MAX_MS=1800000         # 回合停滞预算: 没有工具进展的最长时间(默认30分钟); 0 表示禁用
JEO_TOOL_OUTPUT_MAX=4000        # 模型可见的工具输出上限(全文溢出到 artifacts)
```

重试行为通过 `~/.jeo/config.json` 的 `retry` 调整(`requestMaxRetries`、`streamMaxRetries`、`rateLimitRetries`、`failFastStatuses` 等)。步数预算默认动态 — 只要看到新的进展就延长，停滞时收敛为总结；`--max-steps N` 恢复有界流程。

### 自定义提供商

```jsonc
{
  "customProviders": {
    "my-proxy": {
      "baseUrl": "https://gateway.internal/v1",
      "protocol": "openai",            // 或 "anthropic" (/v1/messages 协议)
      "apiKeyEnv": "MY_PROXY_API_KEY", // 默认: <ID>_API_KEY
      "models": ["fast", "smart"]      // 离线列表；实时 /models 优先
    }
  }
}
```

命令行(`jeo provider add|list|remove|presets|test`)与输入框(`/provider add …`)操作同一份注册表。
`jeo provider test <id>` 会真实探测端点，并**分别报告凭据问题与端点问题**，
失败时以非零码退出，可直接用作部署脚本的检查关卡。

### 子代理扇出并发度

```jsonc
{ "subagentConcurrency": 2 }   // 默认 4，限制在 1~16
```

Anthropic Tier-1 账号在 4 条并发流时会立刻触发限流，使扇出变成比顺序执行**更慢**的
退避风暴。限流紧张的账号请调低，额度充足时可调高。该值同时约束 `task` 工具的
`tasks[]` 批处理与 `eval` 工具的 `parallel`/`pipeline` 辅助函数。

## 技能迁移与内置技能检查

把某个工作流迁移到 jeo 之前，先检查内置默认值，再决定是否安装或覆盖任何内容:

```bash
jeo skills list                 # 内置 + 用户 + 项目技能，附带发现目录
jeo skills read ralplan         # 打印某个技能的完整 SKILL.md
jeo skills sync --check         # 报告与 ~/.jeo/skills 的差异(有差异时非零退出)
```

`jeo skills sync` 会把内置的工作流技能(deep-interview、deep-dive、ralplan、team、ultragoal)安装到 `~/.jeo/skills`，并且**默认保留已有的本地文件** —— 不同的本地副本会被报告为 `preserved`，绝不会被覆盖。如果 `--check` 标记出缺失或不同的文件，先用 `jeo skills read <name>` 对比；只有在确实想替换本地默认工作流技能文件时才使用 `jeo skills sync --force`。可通过末尾路径参数(或 `JEO_CONFIG_DIR`)指定不同目录，并加上 `--json` 获取结构化的 `SkillSyncResult`。

## 开发

jeo 是运行在 Bun 上的纯 TypeScript，**零原生依赖**，因此全局 `jeo` 命令可以直接运行本仓库的源码 —— 无需构建步骤，每次编辑立即生效。

```bash
bun install
bun run dev:link            # 将 `jeo` 软链接到 <repo>/src/cli.ts -> ~/.local/bin
bun run dev:doctor          # 报告全局 `jeo` 是否运行的是本源码(linked/drift/missing)
```

如果 `PATH` 中在受管链接之前还有另一个 `jeo` 遮蔽了它，`dev:link` 会拒绝继续(可用 `JEO_DEV_LINK_DIR` 覆盖目标位置)，并运行一次 `--version` 冒烟测试。当解析出的 `jeo` 是编译后的二进制文件或已安装副本而非本源码时，`dev:doctor` 以非零状态退出。无需链接直接从源码运行: `bun src/cli.ts --help`。内置工作流技能位于源码 `src/prompts/skills/<name>/SKILL.md`；用 `bun run typecheck` 和 `bun test` 验证。

## 发布 (Publishing)

CI 通过 `.github/workflows/npm-publish.yml` 发布 — GitHub 发布 release 时自动触发，或手动 `workflow_dispatch`(可选 dry-run)。工作流依次执行浏览器硬门禁、类型检查、测试(浏览器工具测试在独立进程中)、`pack:check`、打包 tarball 的启动冒烟，然后运行 `npm publish --provenance`。

发布使用 **npm trusted publishing(OIDC)** — 不存在需要轮换、可能泄露或需豁免 2FA 的 `NPM_TOKEN` secret(npm 自 2026 年 8 月起限制绕过 2FA 的令牌，并于 2027 年 1 月终止用其直接发布)。在 npmjs.com 上一次性设置: 包 `jeo-code` → Settings → Trusted Publisher → GitHub Actions，owner `akillness`，repository `jeo-code`，workflow `npm-publish.yml`，environment 留空。该 job 需要 `permissions.id-token: write` 和 npm ≥ 11.5.1(工作流会自行升级 npm)。

## 致谢 (Acknowledgements)

非常感谢 [gajae-code](https://github.com/Yeachan-Heo/gajae-code) 带来的灵感。

## 更新日志 (Changelog)

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[Unreleased]**
- **[0.12.27]** (2026-11-06)
- **[0.12.26]** (2026-11-06)
- **[0.12.25]** (2026-11-06)
- **[0.12.24]** (2026-11-06)

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
