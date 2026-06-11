<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  基于 Bun 的 AI 编码代理 CLI — interviews, reviewed plans, tmux-native execution, durable verification.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
</p>

<p align="center">
  <img src="assets/character.png" alt="jeo-code character mascot" width="320" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>中文</b>
</p>

基于 Bun 的 AI 编码代理 CLI。在仓库中运行 `jeo`，它会读取文件、修改文件、执行命令，并把任务一直推进到完成。
在运行过程中，实时回合（turn）显示为 gjc 风格的扁平内联堆栈（flat inline stack）：完成的工作会以带符号前导的 `✓/✗` 账目行和带边框的工具卡片刷新流入回滚缓冲区（bash 为单一合并卡片 —— `✗ Bash` 标题、`$ command` 回显、`Output` 分隔线、输出正文以及结尾的 `Command exited with code N`；read/find/search 保持单行 `✓ Read path:lines`），其后固定一行带旋转指示的状态行（显示真实的当前目标及紧凑的回合统计信息（step · elapsed · tokens · 实时 `$` 成本））、`Todos` 清单、`◆ hud` 行，以及背景着色的模型状态栏（模型 (提供商) · thinking / `branch ?N` 脏标志 / cwd · 输出 token 速率 `⤴ N/s` · `ctx%`）；助手回复会将 GFM 表格渲染为框线表格，且在输入框（`> Type your message...`，带主题强调色边框，上方固定有模型栏）中输入 `/` 会在下方显示带有 `(i/total)` 位置计数器的命令预览。

状态行显示的是 **当前正在做的事**（正在处理的文件/命令、活动的计划步骤、计划进度，限流退避期间显示 `rate limited (HTTP 429) — auto-retry #2 in 4s` 倒计时），并附带当前步骤已用时间，而不是每个 tick 都变化的装饰文字。模型的回复 **实时流式输出**：在 JSON 工具调用形成时，其推理过程显示为暗淡的 `💭` 行，随后刷新为单行 `jeo · …` 流入回滚缓冲区 —— 按下 **Ctrl+O** 可将完整的最后一次回复（未截断，渲染表格）转储到回滚缓冲区中作为详细视图。内联回合中进化标识只保留最后一行 `Evolved to: …` 摘要（ASCII 艺术页眉保留在传统的 `JEO_TUI_ALT_SCREEN=1` 盒式模式中）。通过 `task` 委派的 **子代理进度**（分配任务、`step N/M`、嵌套工具调用的真实目标——如 `read src/x.ts`、`bash: …`——以及结果摘要）也会像 gjc 一样实时显示在流中。

**剪贴板图像粘贴**：在输入框中按 **Ctrl+V** 即可将复制 of 图像（截图、浏览器右键复制）附加到下一条消息 —— 插入符位置会落入 `[image #N]` 标签，输入框会显示 `⧉ N image(s) attached` 提示，且该附件将作为真实的物理多模态输入发送给所有提供商（Anthropic 内容块、OpenAI 数据 URL、Codex `input_image`、Gemini/Antigravity `inlineData`、Ollama `images[]`）。macOS 在安装了 `pngpaste` 时会使用它（否则回退到 AppleScript）；Linux 使用 `wl-paste`/`xclip`。输入框本身渲染有双色深度线索 —— 明亮的上/左边缘，阴影的下/右边缘 —— 使其读起来像是一个凸起的面板，而不是扁平的轮廓。

**双色面板深度**：所有带边框的面板 —— JEO forge 欢迎框、实时状态框、工具/forge 卡片、外层 alt-screen 框架以及输入框 —— 渲染时都以明亮的上/左边缘（主题强调色）对比暗色的下/右边缘（淡化强调色），并以加粗的标题进行对比，让框体读起来像立体面板而不是扁平轮廓。

**默认值始终跟随最近的选择（所有会话共享）**：选择模型或提供商（`/model …`、`/provider <name> …` 或选择器）会立即持久化到 `~/.joc/config.json` —— 最新选择成为未来所有会话的 `defaultModel`，而 `recentModels` 会保留最新优先的 MRU 轮换列表（由 `/model` 返回给您）。
以命令参数一次性执行请求（例如 `jeo "request"`），在 TTY 上同样会启动相同的实时 TUI；在 `--no-tui`/管道模式下会流式输出 `[step N/M] <tool target>` 以及结果行，以便查看完整的执行流程。

TUI 在 **主终端缓冲区内联**（gjc 风格）渲染实时回合：每个完成的进度行（工具结果、子代理事件、推理）和每个结束的工具卡片在发生时立即刷新流入普通回滚缓冲区中，因此 **在回合进行中，通过 tmux/终端鼠标轮也可以向上滚动回看早期的进度**，同时紧凑的实时框架在底部持续重绘。清除操作是逐行进行的（`ESC[2K`，绝不会是导致回滚缓冲区泛滥的 `ESC[0J`），并且每次刷新和重绘都包装在 **DECSET 2026 同步更新** 中，因此没有任何闪烁；`JEO_TUI_ALT_SCREEN=1` 可以恢复为传统的滚动隔离的 alt-screen 回合。宽度计算从头到尾都 **兼容 CJK/表情符号（CJK/emoji-aware）**，因此宽字符输入和边框绝不会溢出其边界。流/工具列表是一个 **固定大小的环形缓冲区**，因此在长会话中内存和每帧渲染成本保持平稳（即使摘要 LLM 失败，历史记录也会被确定性压缩 —— 采用精确的 Tokenizer 预算控制 —— 绝不会无限增长）。当屏幕过短无法容纳所有区域时，实时框架会从顶部裁剪，以便 **状态行、Todos、hud 和模型状态栏始终可见**。

Forge 框带有边框，因此 **只有能完整放下时才显示**（最新的优先），绝不渲染半个框。

## 安装

要求: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

验证安装:

```bash
jeo --version
```

## 基本用法

```bash
# 运行交互式编码代理
jeo

# 立即执行单个请求
jeo "Tidy up the README and run the tests"

# 检查当前配置与模型连通性（通过真实调用路径探测：Anthropic=GET /v1/models，OpenAI OAuth=Codex 后端，Gemini OAuth=Cloud Code Assist loadCodeAssist）
jeo doctor

# 配置 API 密钥 / OAuth / 本地模型
jeo setup
```

## 交互式斜杠命令

在 `jeo` REPL 输入框中可用的命令（支持 `<Tab>` 自动补全）。

| 命令 | 说明 |
| --- | --- |
| `/model [id\|#N\|save]` | 设置模型（实时 `#N` 选择 · 模糊匹配）。**每次选择都会自动持久化** —— 最新选择成为未来所有会话的默认值，并且 `recentModels` 会保留最新优先的轮换列表（不带参数的 `/model` 会显示它）。`save` 保留为显式别名 |
| `/models [refresh\|caps\|catalog]` | 列出已登录的 OAuth/API 模型（+capability/目录表） |
| `/provider [name] [model\|#N]` | 提供商凭据/切换，以及该提供商的实时模型列表（带有公司名称） |
| `/provider login <name>` | **直接在输入框中进行 OAuth 登录**（anthropic/openai/gemini/antigravity；推荐 antigravity，gemini 作为回退） |
| `/login [name]` · `/logout <name>` | OAuth 登录别名（`/provider login`）· 移除已保存的 OAuth 令牌 |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | 设置子代理角色（executor/planner/architect/critic）的模型/提供商 —— 保存后立即应用于当前会话的 `task` 委派；即使在选择模型期间也可以准备角色目标 |
| `/roles [tier model]` | 显示/设置模型角色层级（smol/slow/plan） |
| `/thinking [level]` | 思考预算（minimal/low/medium/high/xhigh） |
| `/config` | 显示当前运行时配置 |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan`, etc. | 列出/显示/运行工作流技能 —— 像 `$team "task"` 一样用 **`$<skill>`** 直接调用（Codex/gjc 风格，支持 Tab 自动补全）（用户 SKILL.md **仅在显式调用时** 运行） |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | 代码查看 / git diff / 文件与模式搜索 |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | 开始/删除/查看/重命名/恢复会话（对齐 gjc） |
| `/retry` · `/btw <question>` | 重试上一次请求 · 在不触及历史记录的情况下提问旁支问题 |
| `/export [path] [json]` · `/dump` | 将会话记录导出到文件 · 复制到剪贴板 |
| `/usage` · `/context` · `/tools` · `/hotkeys` | 累计 token 用量 · 上下文 token 拆解 · 已公开工具列表 · 快捷键 |
| `/theme [name]` · `/settings` | TUI 主题（cosmic/matrix/solar/red-claw/blue-crab/mono）· 运行时设置（=`/config`） |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | 会话/上下文管理 |

## 常用命令

```bash
# 查看 / 恢复保存的会话
jeo launch --list
jeo launch --resume

# 在 tmux 会话中运行 —— 每次运行都是独立的会话（在相同目录/分支中启动多次会拆分为 base, base-2, base-3 …）
jeo --tmux
jeo --tmux --model gemini-2.5-flash --thinking high
jeo --tmux --models --catalog gpt

# 在单独的 worktree 中运行
jeo --tmux --worktree ../jeo-work

# 列出模型
jeo models

# GJC 风格的模型目录（静态 capability）
jeo --list-models=gemini
jeo --models --catalog gpt

# 启动时指定模型/提供商/思考预算
jeo --model gemini-2.5-flash --thinking high "Analyze this code"
jeo --provider gemini --plan "Draft an implementation plan"
# 斜杠命令面板
# 在 REPL 中输入像 "/" 或 "/m" 这样的前缀会按类别列出命令/选项。
# 子代理设置通过 /agents and /model subagent <role> ... 支持。

# 认证管理
jeo auth login anthropic
jeo auth status
```

## Spec-first 工作流

当你想先理清需求，再进行计划、执行与验证时使用。各个阶段通过状态（`.joc/state/`）承载并设有门禁：deep-interview 首先 **确认顶层拓扑（topology）**，在撰写问题、评估和验收标准时保留输入语言（韩语/英语/日语/中文），对于 brownfield 请求，会收集 **repo 标记 + 路径证据（path evidence）**；随后必须 **冻结 seed**（歧义度 ambiguity ≤ 20%；`--auto`/非 TTY 模式无法绕过该门禁，且如果未达到标准则不会冻结 seed），之后 MutationGuard 才允许修改代码并让 ralplan 继续进行 → ralplan 通过 **Planner→Architect→Critic 共识**（三阶段链式过程，且带有 schema 自校验/修复）构建一个 **待批准（approval-pending）** 的计划 → 必须使用 `jeo approve <plan>` 批准该计划 → 然后 team 执行（损坏 of team 状态会被拒绝而非忽略，未知的子代理角色（subagent roles）在执行前会被拒绝，同名 task 会通过步骤索引路由到正确的角色，并且如果 planner/architect/critic 的报告违反了其契约，或者 architect 返回 `BLOCK`/`REQUEST CHANGES`，或者 critic 返回 `[REJECT]`/`[ITERATE]`，执行将立即停止）→ 最后由 ultragoal 验证 team 的执行结果。

```bash
jeo deep-interview "Describe the feature you want to build"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

## 使用本地模型

配合 Ollama，您可以在本地运行而无需 API 密钥。

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor
jeo
```

## 配置文件

- 全局配置：`~/.joc/config.json`
- 模型选择按 MRU 持久化：`defaultModel` 始终是最新选择，`recentModels` 保留最多 10 个最近的 ID（最新优先）
- 项目状态/会话：`<project>/.joc/`

主要环境变量：

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic        # TUI 主题 (cosmic/matrix/solar/red-claw/blue-crab/mono)
JEO_TUI_ALT_SCREEN=1        # 回退到旧版的 alt-screen 实时回合（默认：主缓冲区内联 + tmux 滚轮回滚）
JEO_STEP_BASE=24            # 动态 step 预算：滚动基数（step N/M 种子）
JEO_STEP_EXTENSIONS=2       # 限制每回合的延长次数（默认：在有进展时无限制；0 = 传统的固定计数器）
JEO_STEP_EXTENSION_SIZE=10  # 每次延长授予的 step 数（默认：基础预算的一半，最少 4）
JEO_STEP_HARD_CAP=75        # 绝对 step 上限（默认：600 —— 仅作为终止保证，而不是任务停止）
JEO_STEP_WINDOW=8           # 用于评估进度的最近工具调用窗口
JEO_TMUX_MOUSE=0            # 关闭 jeo 自有 tmux 会话的鼠标模式（默认开启：滚轮上滚进入 copy-mode 查看真实回滚历史）
JEO_TMUX_PROFILE=0          # 关闭附加 tmux 配置（剪贴板集成 + copy-mode 选区可读样式）
```

```jsonc
{
  "retry": {
    "requestMaxRetries": 4,
    "streamMaxRetries": 2,
    "maxDelayMs": 8000,
    "rateLimitRetries": 6,
    "rateLimitMinDelayMs": 2000,
    "failFastStatuses": [503],
    "failFastPatterns": ["model not found", "context length exceeded"]
  }
}
```

### Step 预算（动态重试流程）

每回合的 step 限制是一个灵活的 **预算**，而不是硬编码的计数器。默认情况下，该预算是 **动态的**：它从一个滚动基数（`JEO_STEP_BASE`，默认 24）开始，只要最近的工具调用窗口显示出真实的、新颖的进展（最近调用成功率 ≥ 50%，涉及 ≥ 2 个不同的目标，并且自上次延长以来至少包含一个从未见过的调用），它就会持续自我延长 —— 没有固定的每个任务的停止点；`JEO_STEP_HARD_CAP`（默认 600）的存在仅仅是为了针对病态循环提供终止保证。每次延长都会留下一行 `↻ step budget extended to M` 账目行，并更新实时的 `step N/M` 分母。停滞的窗口（大多是失败，或在已见过的调用中循环）会拒绝延长，并且循环会转而进行 **整合收尾（consolidation）**：最后一次不调用工具的模型调用将总结已完成的工作、关键发现以及遗留的问题 —— 并在消息中指明拒绝原因。传递显式的 `--max-steps N` 可恢复受限流程（基数 N + 受限的延长）。现有的守卫机制（3 次相同的调用、连续 5 次失败、parse-bounce 兜底救助）保持不变，并且子代理委派（`task`，`jeo team`）保持精确的 step 契约 —— 延长在那里被禁用，而重试的控制权归父级所有。

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
