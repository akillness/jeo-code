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
- **浏览器工具** — 基于 Playwright 的无头 Chromium 自动化,作为一等代理工具:对命名并复用的标签页执行 `open`/`close`/`run`/`act`,优先使用 `observe` 标记的元素 id 而非截图来驱动页面。需要执行一次 `npx playwright install chromium`(未捆绑 — jeo 本身仍是零原生依赖,浏览器二进制文件是 Playwright 的独立下载项)。
- **远程子代理可见性(Telegram)** — 配对一次机器人(`jeo notify setup`)后，`jeo daemon start` 会在子代理每次状态变化(启动 → 完成/失败/取消)时推送消息，并接受 `/subagents`、`/steer <id> <subagentId> <msg>`、`/cancel <id> <subagentId>` 回传。现在提供 Telegram 论坛主题、内联键盘、图片附件等完整 `gjc` parity；命令仅对配对的聊天授权。

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
| `/route [status\|on\|off\|why]` | 切换本会话的基于提示词的模型路由 · 解释最近一次路由决策(仅在已配置凭证 — OAuth 或 API 密钥 — 实际可用的模型内自动路由) |
| `/fast [on\|off\|status]` | 当前模型支持 low 推理时切换 fast thinking 模式 |
| `/skill` · `$<skill> [intent]` | 列出/运行工作流技能(`$team "任务"` 风格) |
| `/view` · `/diff` · `/find` · `/search` | 代码查看、git diff、文件/模式搜索 |
| `/new` · `/resume` · `/sessions` | 会话管理 |
| `/history [n\|all]` · `/export` | 将可读的工作活动历史重新输出到滚动区 · 导出记录 |
| `/retry` · `/btw <问题>` | 重试上次请求 · 不写入历史的旁路提问 |
| `/usage` · `/context` · `/compact` | Token 用量、上下文明细、手动压缩 |
| `/theme` · `/config` · `/help` | 主题、运行时配置、帮助 |
| `jeo autopilot status` | 显示分数方向、keep/revert 次数和下一步动作的 ratchet 状态字段 |

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
- **[0.8.11]** (2026-07-08) — "프롬프트 라우팅 동작이 Error: Unable to connect. Is the computer able to access the url? Error: Was there a typo in the url or port? 와 같은 메시지 남기고 동작안하는데 원인을 파악하고 근본문제해결하자" — traced the raw, provider-less connection error to two compounding gaps. (1) `describeProvider` reports local providers (ollama/lmstudio) as `ready: true` UNCONDITIONALLY — "keyless" only means no credential is required, never that the server is actually reachable — so the routing veto gate (which exists precisely to keep a misconfigured routing target from making a turn worse than routing being off) had no way to catch a `routing.tiers`/`roles` pin to a downed local server. (2) Bun's fetch/undici throws a bare `Error("Unable to connect. Is the computer able to access the url?")` with `.code === "ConnectionRefused"` for BOTH a refused connection and an unresolvable host — no HTTP status, no provider name, no URL — and this fell through every existing error classifier (`defaultRetryable`, `friendlyProviderError`) to reach the user completely unfiltered.
- **[0.8.10]** (2026-07-08) — "지피티 모델 연결이 안되는데 원인파악해서 개선해" — OpenAI's Codex/Responses backend (used by every `gpt-5.5`/`gpt-5.4` OAuth call, and by API-key reasoning models) can emit an in-band `response.failed`/`error` SSE EVENT on an otherwise-200 stream (documented codes: `server_error`, `rate_limit_exceeded` — OpenAI's own guidance is "retry with exponential backoff"). This was thrown as an unclassified bare `Error`, which propagated straight out of the engine's model call with NO retry — a transient OpenAI backend hiccup killed the whole turn outright, surfacing as "GPT doesn't connect" during real interactive use even though `jeo doctor` and a fresh one-shot call both looked healthy (the failure only manifests mid-stream, after the connection has already succeeded).
- **[0.8.9]** (2026-07-08) — "프롬프트 라우팅 속도 문제가 있는거같은데 근본원인 알려줘" — prompt routing incurred significant latency due to a design oversight in LLM-based escalation: when heuristic confidence falls below threshold (standard conceptual questions with no code blocks/file paths conflict-trigger 0.35 confidence), it makes a blocking, synchronous LLM classifier call. If the user's global `thinkingLevel` is enabled (medium/high/xhigh), the cheap classifier model (Haiku 4.5 / GPT-4o-mini) also ran with reasoning enabled, wasting 500ms–1500ms on internal thoughts for a simple 1-word JSON response. The same reasoning-latency leak existed on all other background/internal LLM calls (compaction summarizer, goal verifier, memory distiller), blocking user turns on compaction boundaries.
- **[0.8.8]** (2026-07-08) — "실동작검증을 통해서 유효성 평가하고 개선해줘" — live-verified the v0.8.5 fallback mechanism using active Claude Code OAuth credentials on this machine (confirmed 200 OK for both Fable 5 and Opus 4.8 via the proxy). Identified two critical improvement vectors during verification: (1) server-side fallback was previously scoped strictly to API-key credentials, leaving OAuth users (who also hit `reasoning_extraction` refusals) with today's reactive-only recovery; (2) the sequential `postAnthropic` retry ladder could throw immediately on a combination of different error types (e.g. temperature error first, then fallback error, then success).
- **[0.8.7]** (2026-07-08) — Fix-forward for a CI-caught release failure in v0.8.6 (this same session): `test/launch-prompt-routing.test.ts` shipped with a dropped closing brace (a git 3-way merge misaligned on a duplicate `});` line during this session's own working-tree isolation, then a subsequent `git stash push --keep-index` silently reset the working tree to the pre-fix staged content — the fix was applied once, verified once, then invisibly reverted before the commit that actually shipped). The v0.8.6 GitHub Actions release workflow correctly caught the syntax error at `bun test` and failed BEFORE the npm publish step ran; `npm view jeo-code version` confirmed 0.8.5 remained latest throughout — nothing broken ever reached the registry. Per this repo's established pattern for a same-day CI-caught regression (v0.8.0 → v0.8.1), shipping forward rather than retargeting the already-publicly-failed v0.8.6 tag.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
