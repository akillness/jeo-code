<p align="center">
  <img src="assets/hero.png" alt="jeo-code 自律コーディングエージェントのヒーローイラスト" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun ベースの AI コーディングエージェント CLI — インタビュー、レビュー済みプラン、ゲート付き実行、誠実な検証。
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
</p>

<p align="center">
  <img src="assets/character.gif" alt="最も安価なプロバイダーへプロンプトを賢くルーティングし、コインを稼ぐ動く jeo-code 赤いザリガニマスコット" width="320" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <b>日本語</b> ·
  <a href="README.zh.md">中文</a>
</p>

リポジトリ内で `jeo` を実行すると、ファイルを読み・編集し・コマンドを実行してタスクを完了まで進めます — 全ステップがスクロールバック親和なインライン TUI でライブ配信されます。

## ドキュメント

📖 **[使い方ガイド](docs/usage-guide.md)** — インストール、TUI操作（↑履歴、Ctrl+O、`!`シェル）、スラッシュコマンド、`/resume`、スペックファーストワークフローをデモ動画付きで解説。

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> インライン再生されない場合は ▶ [デモ動画を再生/ダウンロード](docs/jeo-code-promo.mp4)。

## ハイライト

- **マルチプロバイダ・単一ループ** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio に加え、OpenAI・Anthropic 互換クラウド20以上(Groq、DeepSeek、Mistral、OpenRouter、xAI、Kimi、z.ai など)を均一な JSON ツールループで。入力欄から OAuth ログイン(`/provider login`)、モデル選択は即座にデフォルトとして永続化。プロンプトルーティングは実際に使える認証済み経路だけを自動選択します: Gemini OAuth は provider-qualified な `antigravity/*` エージェントセット(Gemini 3.5 Flash 各ティア、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6)へ向かい、`GEMINI_API_KEY` が必要な public `google/gemini-*` 行は選びません。
- **編集の完全性** — read 出力にコンテンツアンカー(`42ab|`)が付き、アンカー付き編集は現在のファイルと照合・行移動時は自動再マッピング・不一致時は最新内容と共に拒否されます。
- **自己修正の検証ループ** — post-edit フック(tsc / eslint / テスト)を設定すると、エージェントが診断を*自ら読み*ループ内で修正します。フックが赤のままだと `done` はブロックされます。
- **芝居なしの本物のゲート** — `ralplan` の合議はリポジトリを実際に読む critic サブエージェントで、`[OKAY]` 評決が永続化され `jeo approve` がそれを*要求*します。`ultragoal` は誠実に報告します(スイート1回実行はグローバル信号であり、基準ごとの合格を捏造しません)。
- **クラッシュ耐久・ローカルファースト** — 全状態は `.jeo/` 配下にアトミック書き込み、プロセス間ロック、失敗タスクマーカー + 再開時の部分編集警告。
- **動的ステップ予算** — 直近のツール呼び出しが新規の進捗を示す間は延長され、停滞すれば要約に収束。サブエージェントは厳密なステップ契約を維持。
- **インライン TUI** — 完了した作業は実スクロールバックに流れ(ターン中も tmux ホイール可)、エージェント実行中も通常のクエリ入力欄が表示されたまま編集できます。Ctrl+O の詳細トグル、テーマ、クリップボード画像貼り付け(Ctrl+V)、CJK/絵文字対応の幅計算。
- **ブラウザツール** — Playwright によるヘッドレス Chromium 自動化を第一級のエージェントツールとして搭載: 名前付きタブを再利用しつつ `open`/`close`/`run`/`act`、スクリーンショットより `observe` でタグ付けした要素 id を優先。`npx playwright install chromium` を一度実行する必要があります(バンドルされていません — jeo 自体はネイティブ依存ゼロのまま、ブラウザバイナリは Playwright 側の別ダウンロードです)。
- **リモートサブエージェント可視化(Telegram)** — ボットを一度ペアリング(`jeo notify setup`)すれば、`jeo daemon start` がサブエージェントの状態遷移(開始 → 完了/失敗/キャンセル)ごとにメッセージを送り、`/subagents`、`/steer <id> <subagentId> <msg>`、`/cancel <id> <subagentId>` を受け付けます。Telegram フォーラムトピック、インラインキーボード、画像添付を含む `gjc` 完全パリティを提供し、コマンドはペアリングされたチャットのみ許可されます。

## インストール

Bun `1.3.14+` が必要です。

```bash
bun install -g jeo-code
jeo --version
```

> リネーム前のバージョンからアップグレードしますか? 旧 CLI 名だった `joc` バイナリは `scripts/install.sh` / `scripts/uninstall.sh` が自動的に削除します。手動で削除する場合: `rm -f ~/.local/bin/joc ~/.bun/bin/joc`。

## クイックスタート

```bash
jeo                      # 現在のリポジトリで対話エージェント
jeo "README を整えてテストを実行して"   # ワンショット要求
jeo doctor               # 設定 + ライブモデル接続チェック
jeo setup                # API キー / OAuth / ローカルモデル設定
jeo --tmux               # 独立した tmux セッションで実行
```

## スラッシュコマンド

`jeo` REPL 内で使用(Tab 補完、`/` でパレット)。

| コマンド | 説明 |
| --- | --- |
| `/model` · `/provider` | モデル/プロバイダ選択; `/model` でデフォルト/ロールバッジ、Ralph 風の入れ子ロール・thinking 選択、OpenAI Codex ロールプリセットを一つの流れで設定 |
| `/provider login <name>` · `/logout` | 入力欄から OAuth ログイン/ログアウト |
| `/agents [role]` · `/subagent` | ロール別(executor/planner/architect/critic)モデル・thinking・ステップ設定 |
| `/thinking [level]` | デフォルト推論予算(low…xhigh)の表示/設定 |
| `/route [status\|on\|off\|why]` | セッション単位のプロンプトベース・モデルルーティングの切替 · 直近のルーティング判断の説明(設定済み資格情報 — OAuth または API キー — が実際に提供するモデルの中でのみ自動ルーティング) |
| `/fast [on\|off\|status]` | 現在のモデルが low 推論をサポートする場合に fast thinking モードを切替 |
| `/skill` · `$<skill> [intent]` | ワークフロースキルの一覧/実行(`$team "task"` 形式) |
| `/view` · `/diff` · `/find` · `/search` | コード表示、git diff、ファイル/パターン検索 |
| `/new` · `/resume` · `/sessions` | セッション管理 |
| `/history [n\|all]` · `/export` | 作業アクティビティ履歴を読みやすくスクロールバックへ再出力・トランスクリプト出力 |
| `/retry` · `/btw <q>` | 直前要求の再試行 · 履歴に残らないサイド質問 |
| `/usage` · `/context` · `/compact` | トークン使用量、コンテキスト内訳、手動コンパクション |
| `/theme` · `/config` · `/help` | テーマ、ランタイム設定、ヘルプ |
| `jeo autopilot status` | スコア方向、keep/revert 数、次アクションを示す ratchet ステータスフィールド |

> [!CAUTION]
> **`/model <name>` で特定モデルを手動指定すると、そのセッション中ルーティングが固定されます。** プロンプトルーティング(`/route`)はモデルが手動固定されていない間のみ毎ターン再評価されます。`/model <name>` で特定モデルを選ぶとその選択が固定され、`/model auto`(ピンを完全に解除)を実行するか、`/route on`(ピンを消さずに優先度だけ上げる — `/route off` した瞬間ピンが復活)を実行するまでルーティングは切り替わりません。`roles.*` 未設定時に `defaultModel` へ確定フォールバックするのは `standard` ティアのみで、`high`/`complex` ティアはフォールバック前にライブでクレデンシャル済みの最強モデルを先に探索するため、未設定でも毎ターン別モデルに着地することがあります。

## Spec-first ワークフロー

要件 → プラン → 承認 → 実行 → 検証が `.jeo/state/` で繋がり、各ハンドオフに**ブロック可能な本物のゲート**があります:

```bash
jeo deep-interview "作りたいものを説明"
jeo ralplan
jeo approve <プランパス>
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

- **deep-interview** — 曖昧度スコアリングのソクラテス式ループ。基準が具体的な場合のみシードを凍結(曖昧のみの基準は拒否)、シードは自身のパーサをラウンドトリップで通過する必要があります。新しいアイデアが完了済みインタビューを黙って再利用することはありません。
- **ralplan** — ドラフトパス + **リポジトリを実際に読む critic サブエージェントゲート**: `[OKAY]`/`[ITERATE]`/`[REJECT]` 評決が強制・永続化されます。無効なプラン(スキーマ・未知ロール)は complete になりません。
- **approve** — `team` が実行する契約(スキーマ+ロール)を検証し、永続化された `[OKAY]` 評決まで要求します。
- **team** — 直列プラン実行器: プロセス間ロック、stale プランのリセット、タスク別サブエージェント契約、親側の変更監査(書き込み0件の「完了」はフラグ)、失敗マーカー + 再開時の部分編集警告。
- **ultragoal** — 誠実な検証: スイートはグローバル信号として1回実行され、基準は記録されるのみで個別合格には捏造されません。

## 検証フック(自己修正)

グローバルで一度有効化(`~/.jeo/config.json` に `"hooks": { "enabled": true }`)し、プロジェクトごとに post-edit チェックを追加すると、エージェントは失敗を読み `done` の前に修正します:

```jsonc
// .jeo/hooks.json
{
  "enabled": true,
  "hooks": [
    { "event": "post-turn", "match": { "tool": "edit|write" }, "run": "bun x tsc --noEmit" }
  ]
}
```

非ゼロ終了したフックの出力はモデルが読むツール結果に付加され(バッチ内で重複排除)、フックが赤のまま `done` を呼ぶとフック名付きでプッシュバックされます。

## メモリフロー

`jeo` は `.jeo/memory/` 配下に **ローカルファースト・蒸留されたプロジェクトメモリ** を保持します(リモートバックエンドなし、ネイティブ依存ゼロ)。過去のセッションは [OKF](docs/okf_mem/) コンセプトバンドルへ蒸留され、次のセッションは関連性の高い予算内のスライスだけをシステムプロンプトへ再注入します — 指示ではなく DATA として堅牢化されます。`JEO_NO_MEMORY=1` ですべて無効化。

**移行(`jeo memory-migrate`、ワンショット・冪等).** レガシーの単一ドキュメント `MEMORY.md` をロスレスでバンドルへ変換します: `## 見出し → タイプ`、各箇条書き → タイプ別コンセプト、インデント行 → 本文; `index.md`/`log.md` を再構築し、元ファイルを `MEMORY.md.bak` にリネームします。バンドルにコンセプトができた後の再実行は no-op です。**ロールバック:** `JEO_MEMORY_LEGACY=1` はバンドルを無視し、同じ注入堅牢化を通して `MEMORY.md`/`.bak` を読みます(`JEO_NO_MEMORY=1` がすべてに優先)。
## 既存のエージェントやボットとの連携 (Works beside your existing agent or bot)

| ツールまたはボット | 推奨される jeo コマンド | 境界 |
| ----------- | ----------------------- | -------- |
| Codex CLI | `jeo --tmux --worktree <name>` または `jeo` | `--worktree` は jeo が管理する兄弟 git worktree を指定します（basename → 新しいブランチ）。既存のパスは先に `cd` してください。 |
| Claude Code | `jeo --tmux` または `jeo --tmux --worktree <name>` | jeo は Claude Code の拡張機能にはなりません。 |
| OpenCode | `jeo` または `jeo --tmux` | 外部ランナーのワークフローのみ。 |
| Claw Code | `jeo --tmux --worktree <name>` | jeo は Claw Code にインストールされたり、置き換えたりしません。 |
| 外部コントローラー / ボット | `jeo mcp serve` (MCP stdio サーバー) | 外部コントローラーはスクロールバックのスクレイピングではなく、MCP ツール契約を介して jeo を駆動します。 |

`--worktree <name>` は隔離された兄弟 git worktree で jeo を実行するため（パスがあれば再利用、なければ basename ブランチで作成）、リスクのある作業やレビュー対象の作業がメインのチェックアウトに触れることはありません。`jeo mcp serve` は stdio を介して MCP 対応のあらゆるコントローラーに jeo のツールを公開します（`jeo mcp tools` で一覧表示）。`-q`/`--quiet` (または `JEO_QUIET=1`) を追加すると、起動バナー・ウェルカムアニメーション・リリースノート・再開ヒントが抑制され、jeo を別のエージェントと並べて実行したりボットから駆動したりできます。`-p`/`--print` は quiet を含みます。

## リモート監視・制御(Telegram)

```bash
jeo notify setup        # BotFather ボットを一度ペアリング(getMe 検証 + chat-id ペアリング)
jeo notify status       # マスクされたトークン、ペアリング済み chat id、デーモン状態
jeo daemon start        # シングルトンのバックグラウンドデーモンを起動
jeo daemon status       # 実行中かどうかを確認
jeo daemon stop         # SIGTERM で停止
```

```
┌─────────────────────┐        ┌─────────────────────┐         ┌─────────────────────┐
│   interactive turn  │◄──ws──►│    notify daemon    │◄─poll──►│     Telegram bot    │
│   SubagentRegistry  │        │     (singleton)     │         │    (paired chat)    │
└─────────────────────┘        └─────────────────────┘         └─────────────────────┘
```

オプトインかつ遅延バインド: `notifications.enabled` が設定され、かつ detached サブエージェント(`task {detached:true}`)が実際に実行されるまで何もバインドされません。デーモンは生存中のセッションディスカバリファイルをスキャンし、セッションごとにループバック WebSocket を接続、サブエージェントの状態 *遷移*(開始 → 完了/失敗/キャンセル)時にのみメッセージを送信します — 「実行中のまま」の繰り返し通知はありません。受信した Telegram コマンドはペアリング済みチャットのみ許可され、それ以外は黙って破棄されます。

| コマンド | 効果 |
| --- | --- |
| `/subagents` | 接続中の全セッションの実行中/最近のサブエージェント一覧 |
| `/steer <sessionId> <subagentId> <message>` | 実行中のサブエージェントへライブメッセージを送信 |
| `/cancel <sessionId> <subagentId>` | 実行中のサブエージェントをキャンセル |
| `/help` | コマンドリファレンスを表示 |

## ローカルモデル

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 設定

- グローバル設定: `~/.jeo/config.json`(モデル選択は MRU 永続)
- プロジェクト状態/セッション: `<project>/.jeo/`

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...           # 例: ollama/qwen2.5:0.5b
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura/gruvbox-dark
JEO_TUI_ALT_SCREEN=1            # レガシー alt-screen ターン(デフォルト: インラインスクロールバック)
JEO_STEP_BASE=24                # 動的ステップ予算のローリングベース
JEO_STEP_HARD_CAP=600           # 絶対終了保証
JEO_STREAM_MAX_MS=1800000       # 全体ストリーム期限(デフォルト30分; スロードリップストリームを制限し、能動中のストリームそのものを止めるための値ではありません); 0 で無効化
JEO_STREAM_IDLE_MS=300000       # チャンク単位のアイドル上限(デフォルト300秒); 最初のトークン前が長い低速/ローカルバックエンドでは引き上げてください
JEO_CALL_TIMEOUT_MS=1800000     # 非ストリーミング呼び出しの壁時計上限(デフォルト30分; compaction/subagents/goal-verify)
JEO_TURN_MAX_MS=1800000         # ターン停滞予算: ツール進捗がない最大時間(デフォルト30分); 0 で無効化
JEO_TOOL_OUTPUT_MAX=4000        # モデル可視のツール出力上限(全文はアーティファクトへ)
```

リトライ動作は `~/.jeo/config.json` の `retry` で調整します(`requestMaxRetries`、`streamMaxRetries`、`rateLimitRetries`、`failFastStatuses` など)。ステップ予算はデフォルトで動的 — 新規進捗が見える間は延長され、停滞時は要約に収束します。`--max-steps N` で有限フローに戻ります。

## スキル移行とバンドルスキルの確認

ワークフローを jeo に移す際は、何かをインストール・上書きする前にバンドルされたデフォルトを確認してください:

```bash
jeo skills list                 # バンドル + ユーザー + プロジェクトのスキル、発見ディレクトリ付き
jeo skills read ralplan         # 1つのスキルの完全な SKILL.md を出力
jeo skills sync --check         # ~/.jeo/skills との差分をレポート(差分があれば非ゼロ終了)
```

`jeo skills sync` はバンドルされたワークフロースキル(deep-interview、deep-dive、ralplan、team、ultragoal)を `~/.jeo/skills` にインストールし、**デフォルトで既存のローカルファイルを保持します** — 異なるローカルコピーは上書きされず `preserved` として報告されます。`--check` が欠落または差分のあるファイルを検出したら、まず `jeo skills read <name>` で比較してください。ローカルのデフォルトワークフロースキルファイルを意図的に置き換えたい場合のみ `jeo skills sync --force` を使用してください。末尾のパス引数(または `JEO_CONFIG_DIR`)で別のディレクトリを指定でき、`--json` で構造化された `SkillSyncResult` を取得できます。

## 開発

jeo は Bun 上の純粋な TypeScript で **ネイティブ依存ゼロ** なので、グローバルの `jeo` コマンドはこのチェックアウトのソースを直接実行できます — ビルド不要、あらゆる編集に即座に反映されます。

```bash
bun install
bun run dev:link            # `jeo` を <repo>/src/cli.ts へシンボリックリンク -> ~/.local/bin
bun run dev:doctor          # グローバル `jeo` がこのソースを実行しているか報告(linked/drift/missing)
```

`dev:link` は `PATH` 上で管理対象リンクより先に別の `jeo` が存在する場合は進行を拒否し(宛先は `JEO_DEV_LINK_DIR` で上書き可能)、`--version` のスモークテストを実行します。`dev:doctor` は解決された `jeo` がこのソースではなくコンパイル済みバイナリやインストール済みコピーの場合に非ゼロで終了します。リンクせずソースから直接実行するには `bun src/cli.ts --help`。バンドルされたワークフロースキルはソース内の `src/prompts/skills/<name>/SKILL.md` にあります; `bun run typecheck` と `bun test` で検証してください。

## 公開 (Publishing)

CI は `.github/workflows/npm-publish.yml` で公開します — GitHub リリース公開時に自動、または `workflow_dispatch` の手動実行(ドライラン可)。ワークフローは型チェック・テスト・トークン検証(`npm whoami`)の後、`npm publish --provenance` を実行します。

必要な npm トークン権限(リポジトリシークレット `NPM_TOKEN`):

- `jeo-code` パッケージへの Read/Write 権限を持つ **Granular Access Token**、またはクラシック **Automation** トークン
- 「公開時の **bypass 2FA**」許可が必須 — Automation トークンは常にバイパス、granular トークンはオプションの有効化が必要

## 謝辞 (Acknowledgements)

[gajae-code](https://github.com/Yeachan-Heo/gajae-code) に多大な感謝を。

## 変更履歴 (Changelog)

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[0.8.17]** (2026-07-09) — "서브에이전트 이용해. 병렬루 부가 나머지모두 개선하고 검증후 배포까지하자" — a prior 4-way parallel subagent cross-verification pass found the README `[!CAUTION]` routing-lock block (added this session for "프롬프트 라우팅이 한번 정해지면 안바뀌는데?") was directionally correct but had 2 real inaccuracies, plus a concrete test-coverage gap: every existing pin/override regression test drove the lock via the `--model` CLI startup flag, never via typing `/model <name>` as an interactive slash command mid-session, and none proved persistence across 3+ consecutive turns.
- **[0.8.16]** (2026-07-09) — "jeo code의 computer use 기능은 / 명령어로 설정할수있도록하고, 실동작검증까지진행해줘" — the desktop-automation `computer` tool was only togglable by hand-editing `computer.enabled` in `~/.jeo/config.json`; there was no in-session way to enable it for a single run without leaving a permanent config change behind.
- **[0.8.15]** (2026-07-09) — "api 인증 모델도 사용가능하도록 딥리서치하고 개선해줘" — traced the API-authenticated GPT path to a routing catalog gap: `GET /models` with an OpenAI API key or an OpenAI-compatible provider returned real account-scoped model ids, and `/model` could show/pin them, but prompt routing still built its auto-select pools from static `MODEL_CATALOG` rows only. A custom `openaiBaseUrl` made this worse by treating every public OpenAI row as servable, so routing could choose `gpt-*`/`o*` ids that the configured local/Azure/proxy endpoint never listed.
- **[0.8.14]** (2026-07-09) — "GPT 연결 실패가 여전히 무응답으로 끝나는 케이스를 잡아줘" — traced the remaining GPT/routing failure path to post-call continuity: the route target could be credentialed and servable, but still end a turn with a recoverable terminal result such as plain `OpenAI returned no content`, rate/quota pressure, model unavailable/not found, or an invalid agent-tool response. jeo already knew the prompt tier and equivalent credentialed fallbacks, but it only applied that fallback before the model call. After the call failed, the turn stopped instead of trying another model in the same tier.
- **[0.8.13]** (2026-07-09) — "테스트검증 jeo --tmux 로 진행해줘" — traced a routing recovery weakness that survived the earlier credential, servability, and local reachability vetoes: once a configured route target was rejected, jeo threw away the whole routing decision and dropped to the session/default model even when the same prompt tier had another credentialed, servable model available. That kept turns working, but it also silently undid routing's cost/latency goal and made `/route why` less useful because the recorded decision was a fallback note instead of the actual model used.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
