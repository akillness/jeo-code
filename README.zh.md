<p align="center">
  <img src="assets/hero.png" alt="jeo-code 自主编码代理主视觉插图" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  基于 Bun 的 AI 编码代理 CLI — 需求访谈、经评审的计划、带门禁的执行、诚实的验证。
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
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

📖 **[使用指南](docs/usage-guide.md)** — 安装、TUI 操作（↑ 历史、Ctrl+O、`!` shell）、斜杠命令、`/resume`、规格优先工作流，附演示视频。

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> 无法内联播放？▶ [播放/下载演示视频](docs/jeo-code-promo.mp4)。

## 亮点

- **多提供商、单一循环** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio，以及 20+ 个 OpenAI、Anthropic 兼容云服务(Groq、DeepSeek、Mistral、OpenRouter、xAI、Kimi、z.ai 等)，统一在一个 JSON 工具循环中。输入框内直接 OAuth 登录(`/provider login`)，模型选择即刻持久化为默认值。Prompt routing 只会自动选择真实可用的凭据路径: Gemini OAuth 会走 provider-qualified 的 `antigravity/*` 代理模型集(Gemini 3.5 Flash 各档、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6)，绝不选择需要 `GEMINI_API_KEY` 的 public `google/gemini-*` 行。
- **编辑完整性** — read 输出携带内容锚点(`42ab|`)；带锚点的编辑会与当前文件校验、行移动时自动重映射、不匹配时连同最新内容一起拒绝 — 绝不污染文件。
- **自我修正的验证循环** — 配置 post-edit 钩子(tsc / eslint / 测试)，代理会*亲自读取*诊断并在循环内修复；钩子未通过时 `done` 会被阻断。
- **没有表演的真实门禁** — `ralplan` 共识由真正读取仓库的 critic 子代理执行，`[OKAY]` 裁决被持久化且 `jeo approve` *强制要求*它；`ultragoal` 诚实报告(套件运行只是全局信号，绝不伪造逐条通过)。
- **崩溃耐久、本地优先** — 全部状态位于 `.jeo/`，原子写入、跨进程运行锁、失败任务标记 + 恢复时的部分编辑警告。
- **动态步数预算** — 只要近期工具调用展现新的进展就持续延长，停滞时优雅收敛为总结；子代理保持精确的步数契约。
- **内联 TUI** — 已完成的工作流入真实滚动缓冲区(回合中也可用 tmux 滚轮)，代理运行时普通查询输入框仍保持可见并可编辑。Ctrl+O 详细信息切换、主题、剪贴板图片粘贴(Ctrl+V)、CJK/表情安全的宽度计算。
- **浏览器工具** — 基于 Playwright 的无头 Chromium 自动化,作为一等代理工具:对命名并复用的标签页执行 `open`/`close`/`run`/`act`,优先使用 `observe` 标记的元素 id 而非截图来驱动页面。`act {verb:"verify", goal, ...}` 闭合了可视化 QA 循环:对页面截图,并让一个独立的、具备视觉能力的模型依据一句大白话目标来判断(`{verdict:"PASS"|"MISMATCH", detail}`),不再需要人工(或同一个代理)去肉眼核对保存下来的 PNG。需要执行一次 `npx playwright install chromium`(未捆绑 — jeo 本身仍是零原生依赖,浏览器二进制文件是 Playwright 的独立下载项)。
- **持续积累的技能** — 卡壳的一轮现在会把死胡同写入同一个技能的项目级文件(`.jeo/skills/<name>.md`,首次写入时从内置技能播种,采用确定性关键词匹配,不使用 LLM),因此下一个会话的 `$<skill>` 调用会带上累积的"Known Failure Modes"/"Anti-Patterns"知识,而不是让内置文档永远保持静态。手动记录用 `jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"`;`jeo skills eval <skill>` 会运行一次真正的 LLM 判断,检查每条已记录的经验是否仍被技能当前的指引覆盖,还是已经过时。
- **低价位评分模型路由** — `/goal` 验证器、`critic` 子代理角色,以及未锁定的 `task` 扇出批次,现在默认使用低价位、已配置凭证的模型,而不是悄悄搭乘与它们所评分/执行的工作相同的全价模型(`resolveVerifierModel`,针对浏览器 `verify` 动作按视觉能力过滤,确保纯文本的低价模型不会悄悄丢弃附带的截图)。
- **`jeo routine init`** — 生成一个 GitHub Actions 工作流,在 schedule/issue/PR 触发器上以无头模式运行 jeo(`jeo "<prompt>" -p`),运行在 GitHub 自己的 runner 上 — 不需要笔记本电脑,并且不会给 jeo 自身增加任何新的攻击面(没有进程内调度器或 webhook 监听器)。`--dry-run` 可预览,`--no-pr` 则改为直接提交而非默认的每次运行一个 PR。
- **远程子代理可见性(Telegram)** — 配对一次机器人(`jeo notify setup`)后，`jeo daemon start` 会在子代理每次状态变化(启动 → 完成/失败/取消)时推送消息，并接受 `/subagents`、`/steer <id> <subagentId> <msg>`、`/cancel <id> <subagentId>` 回传。现在提供 Telegram 论坛主题、内联键盘、图片附件等完整 `gjc` parity；命令仅对配对的聊天授权。
- **不阻塞回合的会话级异步执行** — 通过 `task` 工具真实的 `tasks` 数组扇出独立工作，不阻塞父回合。detached 子代理、后台 job 和逐行 monitor 可在后续回合中继续使用 `subagent`/`job`/`monitor` 的 `list`、`inspect`、`await`、`cancel`、`tail` 控制。内联 TUI 为每个 worker 保留独立的实时 activity 槽位，并在会话退出或 Ctrl-C 时清理全部 registry。
- **独立验证器，真正强制执行** — 计划再也无法跳过 architect/critic 步骤: `PlanSchema` 会拒绝任何以未验证变更结尾的计划(把验证器放在它该检查的变更之前也不算数)，在 `ralplan` 起草阶段和 `team`/`approve` 执行阶段都强制生效。每一次 architect/critic 裁决也都必须展示真实证据 — 观测到的 `read`/`search`/`find`/`ast_grep`/`lsp` 调用为零，无论文本怎么声称，裁决都会被拦下。
- **安全边界自动模型回退** — 未分类的安全拒绝(可能是分类器误报，而非真实的内容策略命中)现在会切换到真正不同提供商的模型，而不是在同一个模型上无限退让 — 与现有的 rate-limit 快速回退是同一套模式。`Refusal (<category>)` 这种形态的确定性拒绝不受影响，仍然零回退硬失败。
- **内存: 应得的信任** — 概念的验证日期现在只在蒸馏阶段被明确标记为已验证时才会写入，而不是每次写入都记录；`isConceptStale` 把未验证(或超过 30 天过期)的概念视为需要重新验证，而不是信任一个被动的时间戳。
- **动态工作流(`eval` 工具)** — 围绕子代理派遣编写真正的 JS 控制流: `task(role, taskText, context?)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`log(message)`，组合出 `task` 单阶段 `tasks[]` 批次无法表达的顺序/分支编排。运行在隔离的 Worker 线程中，具备真正的抢占式超时(`worker.terminate()`，而非同进程内的竞争) — 与 `bash` 同等的全进程信任级别，不假装沙箱，受同一个 interview 变更锁门控。
- **在破损输出管道上安静退出** — 当管道输出到提前停止读取的命令时(`jeo --help | head`、消失的远程对端),不再转储原始的 `EPIPE` 堆栈 — 现在会以 shell 对被 SIGPIPE 终止的管道生产者报告的相同退出码(141)安静退出。真正的崩溃不受影响,仍会清晰地暴露出来。
- **macOS 低文件描述符上限警告** — 较低的 `ulimit -n`(BSD 默认 256/1024)可能导致文件监视、浏览器工具或大范围仓库扫描出现不明的 `EMFILE` 失败 — jeo 现在会在启动时警告一次(仅 stderr,绝不污染被管道的 `-p` 输出),并给出具体的 `ulimit`/`launchctl` 指引。可通过 `JEO_SKIP_NOFILE_CHECK=1` 选择退出。

## 安装

需要 Bun `1.3.14+`。

```bash
bun install -g jeo-code
jeo --version
```

> 从重命名前的版本升级？旧 CLI 名称 `joc` 的二进制文件现在会被 `scripts/install.sh` / `scripts/uninstall.sh` 自动移除；手动移除: `rm -f ~/.local/bin/joc ~/.bun/bin/joc`。

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
| `/model` · `/provider` | 选择模型/提供商；`/model` 在一个流程内显示默认/角色徽章、Ralph 风格嵌套角色·thinking 选择与 OpenAI Codex 角色预设 |
| `/provider login <name>` · `/logout` | 在输入框内 OAuth 登录/登出 |
| `/agents [role]` · `/subagent` | 按角色(executor/planner/architect/critic)配置模型·thinking·步数 |
| `/thinking [level]` | 查看/设置默认推理预算(low…xhigh) |
| `/route [status\|on\|off\|why\|history [n]]` | 切换本会话的基于提示词的模型路由 · 解释最近一次路由决策 · `history [n]` 列出本会话最近 n 条(默认 10 条)路由决策(仅在已配置凭证 — OAuth 或 API 密钥 — 实际可用的模型内自动路由) |
| `/fast [on\|off\|status]` | 当前模型支持 low 推理时切换 fast thinking 模式 |
| `/skill` · `$<skill> [intent]` | 列出/运行工作流技能(`$team "任务"` 风格) |
| `/view` · `/diff` · `/find` · `/search` | 代码查看、git diff、文件/模式搜索 |
| `/new` · `/resume` · `/sessions` | 会话管理 |
| `/history [n\|all]` · `/export` | 将可读的工作活动历史重新输出到滚动区 · 导出记录 |
| `/retry` · `/btw <问题>` | 重试上次请求 · 不写入历史的旁路提问 |
| `/usage` · `/context` · `/compact` | Token 用量、上下文明细、手动压缩 |
| `/theme` · `/config` · `/help` | 主题、运行时配置、帮助 |
| `jeo autopilot status` | 显示分数方向、keep/revert 次数和下一步动作的 ratchet 状态字段 |

> [!CAUTION]
> **通过 `/model <name>` 手动指定模型后，路由会在本会话内保持锁定。** Prompt routing(`/route`)只在没有手动锁定模型时才会逐轮重新评估。用 `/model <name>` 选定具体模型后，该选择会被锁定 — 直到你运行 `/model auto`(彻底解除锁定)，或运行 `/route on`(不会清除锁定，只是优先级更高 — 一旦运行 `/route off`，锁定会立刻恢复)之前，路由都不会再切换。未配置 `roles.*` 条目时，只有 `standard` 层级会确定性地退回到 `defaultModel`；`high`/`complex` 层级通常会先实时扫描已配置凭证中最强的可用模型再决定是否回退，所以即使未配置，也可能每轮落到不同的模型上。**例外:** 通过 Antigravity 或 Gemini OAuth 授权的会话会用同一个凭证重新导出 Anthropic/Google/OpenAI 的模型 —此时 `high`/`complex` 会按公司各选一个模型、以会话为单位稳定分布(不一定是最强的那个)，因此在同一会话内保持固定，而不是逐轮变化。

## Spec-first 工作流

需求 → 计划 → 批准 → 执行 → 验证，经由 `.jeo/state/` 串联，每次交接都有**可阻断的真实门禁**:

```bash
jeo deep-interview "描述你想构建的东西"
jeo ralplan
jeo approve <计划路径>
jeo team
jeo ultragoal
```
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
  │      ultragoal       │  Honest verification — suite once, no fabrication
  └──────────────────────┘
```

- **deep-interview** — 基于歧义度评分的苏格拉底循环；只有标准足够具体才冻结种子(纯含糊标准会被拒绝)，且种子必须通过自身解析器的往返校验。新想法绝不会静默复用已完成的访谈。
- **ralplan** — 起草阶段 + **真正读取仓库的 critic 子代理门禁**: 强制并持久化 `[OKAY]`/`[ITERATE]`/`[REJECT]` 裁决。无效计划(schema、未知角色)不会被标记为 complete。
- **approve** — 校验 `team` 执行的确切契约(schema+角色)，并要求持久化的 `[OKAY]` 共识裁决。
- **team** — 串行计划执行器: 跨进程运行锁、过期计划重置、按任务的子代理契约、父侧变更审计(零写入的"完成"会被标记)、失败标记 + 恢复时的部分编辑警告。
- **ultragoal** — 诚实验证: 套件作为全局信号只运行一次，标准只被记录，绝不伪造为逐条通过。

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

## 远程监控与控制 (Telegram)

```bash
jeo notify setup        # 配对一次 BotFather 机器人(getMe 校验 + chat-id 配对)
jeo notify status       # 已遮蔽的令牌、已配对 chat id、守护进程状态
jeo daemon start        # 启动单例后台守护进程
jeo daemon status       # 检查是否正在运行
jeo daemon stop         # 发送 SIGTERM 停止
```

```
┌─────────────────────┐        ┌─────────────────────┐         ┌─────────────────────┐
│   interactive turn  │◄──ws──►│    notify daemon    │◄─poll──►│     Telegram bot    │
│   SubagentRegistry  │        │     (singleton)     │         │    (paired chat)    │
└─────────────────────┘        └─────────────────────┘         └─────────────────────┘
```

默认关闭、延迟绑定:只有设置了 `notifications.enabled` 且真正运行了一个 detached 子代理(`task {detached:true}`)才会绑定。守护进程扫描存活的会话发现文件,为每个会话建立一条回环 WebSocket,并且只在子代理状态发生*变化*时(启动 → 完成/失败/取消)推送消息 — 绝不会重复推送"仍在运行"这类状态。收到的 Telegram 命令仅对已配对的聊天授权,其余一律静默丢弃。

| 命令 | 效果 |
| --- | --- |
| `/subagents` | 列出所有已连接会话中正在运行/最近的子代理 |
| `/steer <sessionId> <subagentId> <message>` | 向正在运行的子代理发送实时消息 |
| `/cancel <sessionId> <subagentId>` | 取消正在运行的子代理 |
| `/help` | 显示命令参考 |

## 例行任务 (GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

生成一个 GitHub Actions 工作流(`.github/workflows/<name>.yml`),安装 jeo 并在 `schedule` / `issues` / `pull_request` 上以无头模式运行它(`jeo "<prompt>" -p`)— 始终与 `workflow_dispatch` 搭配,便于手动测试运行 — 运行在 GitHub 自己的托管 runner 上。这就是 jeo "无需笔记本电脑运行"的故事:jeo 自身内部没有进程内调度器、没有 webhook 监听器、没有代码执行沙箱 — 由 GitHub 的基础设施负责触发,jeo 只是运行它现有的无头模式。默认在有任何变更时开一个 PR(`peter-evans/create-pull-request`,diff 为空时是安全的空操作);`--no-pr` 则改为直接提交到触发分支。`--dry-run` 只打印 YAML 而不写入;在相同的 `--out` 路径上重新运行 `jeo routine init`,若不加 `--force` 会拒绝覆盖。请在工作流首次真正运行前,设置好仓库密钥 `ANTHROPIC_API_KEY`(或 `--api-key-env <VAR>`)。

## 本地模型

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 配置

- 全局配置: `~/.jeo/config.json`(模型选择 MRU 持久化)
- 项目状态/会话: `<project>/.jeo/`

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

CI 通过 `.github/workflows/npm-publish.yml` 发布 — GitHub 发布 release 时自动触发，或手动 `workflow_dispatch`(可选 dry-run)。工作流执行类型检查、测试、令牌校验(`npm whoami`)后运行 `npm publish --provenance`。

所需 npm 令牌权限(仓库 secret `NPM_TOKEN`):

- 对 `jeo-code` 包具有 Read/Write 权限的 **Granular Access Token**，或经典 **Automation** 令牌
- 必须允许"发布时 **bypass 2FA**" — Automation 令牌始终绕过，granular 令牌需启用该选项

## 致谢 (Acknowledgements)

非常感谢 [gajae-code](https://github.com/Yeachan-Heo/gajae-code) 带来的灵感。

## 更新日志 (Changelog)

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[Unreleased]**
- **[0.9.6]** (2026-07-27) — Resize-safe ledger flush and terminal clear handling after viewport shrink.
- **[0.9.5]** (2026-07-27) — Resize-safe live TUI rendering for terminal viewport shrink/grow transitions.
- **[0.9.4]** (2026-07-27) — Real OpenAI/Codex model discovery after login, npm package-content hardening, and pinned self-update support.
- **[0.9.3]** (2026-07-26) — Released Telegram integration reliability improvements adapted from GJC v0.11.10, with safe jeo-native behavior and live verification.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
