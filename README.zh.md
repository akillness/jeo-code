<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (joc)</h1>

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

基于 Bun 的 AI 编码代理 CLI。在仓库中运行 `joc`，它会读取文件、修改文件、执行命令，并把任务一直推进到完成。
运行过程中显示 gjc 风格的扁平内联堆栈：完成的工作以 `✓/✗` 单行账目和带边框的工具卡片（bash 为单一合并卡片 —— `✗ Bash` 标题、`$ 命令` 回显、`── Output ──` 分隔线、输出正文、结尾的 `Command exited with code N`；read/find/search 保持 `✓ Read path:lines` 单行）流入回滚缓冲区，其下固定一行带旋转指示的状态行（真实的当前目标 + step · 已用时间 · token · 实时 `$` 成本）、`Todos` 清单、`◆ hud` 行，以及带背景色的模型状态栏（模型（提供商）· thinking / `branch ?N` / cwd · `⤴ N/s` · `ctx%`）；在输入框（`> Type your message...`，主题强调色边框）中以 `/` 开头会在底部显示命令预览。

状态行显示的是 **当前正在做的事**（正在处理的文件/命令、活动的 plan 步骤、plan 进度，限流退避期间显示 `rate limited (HTTP 429) — auto-retry #2 in 4s` 倒计时），并附带当前步骤已用时间，而不是每个 tick 都变化的装饰文字。内联回合中进化标识只保留最后一行 `Evolved to: …` 摘要，ASCII 艺术页眉保留在传统的 `JOC_TUI_ALT_SCREEN=1` 盒式模式中。通过 `task` 委派的 **子代理进度**（分配、`step N/M`、嵌套工具调用的真实目标 `read src/x.ts`、`bash: …`、结果摘要）也会像 gjc 一样实时显示在流中。

即使像 `joc "请求"` 这样以命令参数一次性执行，在 TTY 上同样会启动相同的实时 TUI；在 `--no-tui`/管道模式下会流式输出 `[step N/M] <tool target>` 与结果行，从而看到完整的执行流程。

TUI 使用 **差分（differential）渲染器** 就地刷新屏幕，不会增加回滚缓冲（完成的账目行与工具卡片会在发生时立即流入回滚缓冲区，因此 tmux/鼠标滚轮在回合进行中也能回看早前进度）；当窗口尺寸变化导致宽度改变时会整屏重绘，即使在空闲提示符下也会通过 resize 重新同步页脚区域。流/工具列表是 **固定大小的环形缓冲区**，因此在长会话中内存与每帧渲染成本保持平稳（即使摘要 LLM 失败，历史也会被确定性地压缩，不会无限增长）。当屏幕过短无法容纳所有区块时，会 **始终优先保留状态行、Todos、hud 与模型栏**，剩余的行才用于进行中的工具卡片。

forge 框带有边框，因此 **只有能完整放下时才显示**（优先显示最新的），绝不渲染半个框。

## 安装

要求: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

确认安装:

```bash
joc --version
```

## 基本用法

```bash
# 启动交互式编码代理
joc

# 立即执行一次请求
joc "整理 README 并运行测试"

# 检查当前配置与模型连通性（通过真实调用路径探测: Anthropic=GET /v1/models, OpenAI OAuth=Codex 后端, Gemini OAuth=Cloud Code Assist loadCodeAssist）
joc doctor

# 配置 API 密钥 / OAuth / 本地模型
joc setup
```

## 交互式斜杠命令

可在 `joc` REPL 输入框中使用的命令（支持 `<Tab>` 自动补全）。

| 命令 | 说明 |
| --- | --- |
| `/model [id\|#N\|save]` | 设置模型（实时 #N 选择 · 模糊匹配）。**选择即自动持久化** — 最近一次选择成为所有新会话的默认模型，`recentModels` 保留最新优先的轮换列表（不带参数的 `/model` 会显示）。`save` 保留为显式别名 |
| `/models [refresh\|caps\|catalog]` | 列出已登录的 OAuth/API 模型（+capability/目录表） |
| `/provider [name] [model\|#N]` | 提供商凭据/切换，以及该提供商的实时模型列表（标注公司名） |
| `/provider login <name>` | **直接在输入框中进行 OAuth 登录**（anthropic/openai/gemini/antigravity；推荐 antigravity，gemini 作为回退） |
| `/login [name]` · `/logout <name>` | OAuth 登录别名（`/provider login`）· 移除已保存的 OAuth 令牌 |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | 设置子代理（executor/planner/architect/critic）各角色的模型/提供商（保存后立即作用于当前会话的 `task` 委派；在选择模型期间也可准备 role target） |
| `/roles [tier model]` | 显示/设置模型角色层级（smol/slow/plan） |
| `/thinking [level]` | 思考预算（minimal/low/medium/high/xhigh） |
| `/config` | 显示当前运行时配置 |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan` 等 | 列出/显示/运行工作流 skill —— 像 `$team "任务"` 一样用 **`$技能名` 直接调用**（Codex/gjc 风格，Tab 自动补全）（用户 SKILL.md **仅在显式调用时** 执行） |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | 代码查看 / git diff / 文件与模式搜索 |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | 开始/删除/查看/重命名/恢复会话（gjc parity） |
| `/retry` · `/btw <question>` | 重试上一次请求 · 在不触动历史的情况下问一个旁支问题 |
| `/export [path] [json]` · `/dump` | 将会话记录导出到文件 · 复制到剪贴板 |
| `/usage` · `/context` · `/tools` · `/hotkeys` | 累计 token 用量 · 上下文 token 拆解 · 已暴露工具列表 · 快捷键 |
| `/theme [name]` · `/settings` | TUI 主题（cosmic/matrix/solar/red-claw/blue-crab/mono）· 运行时设置（=`/config`） |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | 会话/上下文管理 |

## 常用命令

```bash
# 查看 / 恢复已保存的会话
joc launch --list
joc launch --resume

# 在 tmux 会话中运行 —— 每次运行都是独立会话（在相同目录/分支中同时多次启动会拆分为 base, base-2, base-3 …）
joc --tmux
joc --tmux --model gemini-2.5-flash --thinking high
joc --tmux --models --catalog gpt

# 在单独的 worktree 中运行
joc --tmux --worktree ../joc-work

# 列出模型
joc models

# GJC 风格的模型目录（静态 capability）
joc --list-models=gemini
joc --models --catalog gpt

# 启动时指定模型/提供商/思考预算
joc --model gemini-2.5-flash --thinking high "分析这段代码"
joc --provider gemini --plan "起草一份实现计划"
# 斜杠命令面板
# 在 REPL 中输入像 "/" 或 "/m" 这样的前缀，会按类别列出命令/选项。
# 子代理设置通过 /agents 和 /model subagent <role> ... 支持。

# 认证管理
joc auth login anthropic
joc auth status
```

## Spec-first 工作流

当你想先理清需求，再进行计划、执行与验证时使用。各阶段通过状态（`.joc/state/`）衔接并设有门禁: deep-interview 先 **确认顶层拓扑（topology）**，在撰写问题、评估与验收标准时保留输入语言（韩语/英语/日语/中文）；若为 brownfield 请求，会收集 **repo 标记 + path evidence**，随后必须 **冻结 seed**（ambiguity ≤ 20%；`--auto`/非 TTY 也无法绕过该门禁，未达标则不冻结 seed），之后 MutationGuard 才允许代码修改并进入 ralplan → ralplan 通过 **Planner→Architect→Critic 共识**（三阶段链式过程）生成 **待批准** 的计划（含 schema 自校验/修复）→ 必须用 `joc approve <plan>` 批准 → 然后 team 执行（损坏的 team 状态会被拒绝而非忽略，未知的 subagent role 在执行前被拒绝，同名 task 也会按 step index 路由到正确的 role；若 planner/architect/critic 的 report 不符合契约，或 architect 返回 `BLOCK`/`REQUEST CHANGES`、critic 返回 `[REJECT]`/`[ITERATE]`，则立即中止）→ ultragoal 验证 team 的执行结果。

```bash
joc deep-interview "描述你想构建的功能"
joc ralplan
joc approve <plan-path>
joc team
joc ultragoal
```

## 使用本地模型

使用 Ollama 即可在本地运行，无需 API 密钥。

```bash
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b
joc doctor
joc
```

## 配置文件

- 全局配置: `~/.joc/config.json`
- 项目状态/会话: `<project>/.joc/`

主要环境变量:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JOC_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JOC_TUI_THEME=cosmic        # TUI 主题 (cosmic/matrix/solar/red-claw/blue-crab/mono)
JOC_TUI_ALT_SCREEN=1        # 回退到旧版 alt-screen 实时回合（默认: 主缓冲区内联 + tmux 滚轮回滚）
```

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
