<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun ベースの AI コーディングエージェント CLI — interviews, reviewed plans, tmux-native execution, durable verification.
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
  <b>日本語</b> ·
  <a href="README.zh.md">中文</a>
</p>

Bun ベースの AI コーディングエージェント CLI です。リポジトリ内で `jeo` を実行すると、ファイルを読み込み、編集し、コマンドを実行して、タスクを最後まで遂行します。
実行中は gjc スタイルのフラットなインラインスタックが表示されます: 完了した作業は `✓/✗` の 1 行レジャーと枠付きツールカード（bash は `✗ Bash` タイトル・`$ コマンド` エコー・`── Output ──` 区切り・出力本文・末尾の `Command exited with code N` を統合した単一カード、read/find/search は `✓ Read path:lines` の 1 行）としてスクロールバックに流れ、その下に実際の処理対象を示すスピナー付きステータス 1 行（step・経過・トークン・ライブ `$` コスト）、`Todos` チェックリスト、`◆ hud` 行、背景色付きモデルステータスバー（モデル（プロバイダー）・thinking / `branch ?N` / cwd・`⤴ N/s`・`ctx%`）がピン留めされます。入力欄（`> Type your message...`、テーマアクセントの枠）で `/` を入力するとコマンドプレビューが下部に表示されます。

ステータス行は、ティックごとに変わる装飾文ではなく、**いま実際に行っていること**（処理中のファイル・コマンド、アクティブな plan ステップ、plan の進捗、レート制限バックオフ中は `rate limited (HTTP 429) — auto-retry #2 in 4s` のカウントダウン）を、現在のステップ経過時間とともに表示します。インラインターンでは進化のアイデンティティは最後の `Evolved to: …` サマリ 1 行に集約され、ASCII アートヘッダーはレガシーの `JEO_TUI_ALT_SCREEN=1` ボックスモードに残ります。`task` で委任された **サブエージェントの進捗**（割り当て・`step N/M`・ネストしたツール呼び出しの実際の対象 `read src/x.ts`・`bash: …`・結果サマリ）も gjc と同様にストリームへリアルタイム表示されます。

`jeo "リクエスト"` のようにコマンド引数で一度に実行しても、TTY では同じライブ TUI が立ち上がり、`--no-tui`/パイプモードでは `[step N/M] <tool target>` と結果行がストリーミングされ、動作の流れ全体が見えます。

TUI は **差分（differential）レンダラー** で画面をその場で更新し、スクロールバックを増やしません（完了したレジャー行とツールカードは発生と同時にスクロールバックへ流れるため、tmux／マウスホイールでターン中でも過去の進捗を確認できます）。画面サイズが変わって幅が変化したときは全体を再描画し、アイドルプロンプトでもリサイズでフッター領域を再同期します。ストリーム／ツールリストは **固定サイズのリングバッファ** なので、長いセッションでもメモリとフレームあたりの描画コストが平坦に保たれます（要約 LLM が失敗しても履歴は決定的に圧縮され、無限に増えません）。画面が短くすべてのセクションが収まらない場合は、**ステータス行・Todos・hud・モデルバーを必ず最初に確保** し、残りの行だけを処理中のツールカードに使います。

forge ボックスは枠があるため、**まるごと収まるときだけ**（新しいもの優先）表示し、半分だけのボックスは作りません。

## インストール

要件: Bun `1.3.14+`

> **リネームのお知らせ**: バイナリ名は `jeo` になりました（旧 `joc`）。`joc` コマンドは互換エイリアスとして引き続き動作し、レガシーの `JOC_*` 環境変数も認識されます（`JEO_*` 表記を推奨）。既存の `~/.joc` / `.joc` ランタイム状態はそのまま使用されます。

**ツートーンのパネル深度**: すべての枠付きパネル（JEO forge ウェルカムボックス、ライブステータスボックス、ツール/forge カード、外枠フレーム、入力ボックス）が、明るい上/左エッジ（テーマアクセント）と暗い下/右エッジ（淡色アクセント）で描画され、タイトルは太字でコントラストされるため、立体的なパネルとして見えます。

**デフォルトは常に最新の選択に従う（全セッション共有）**: モデル/provider を選択すると（`/model …`、`/provider <name> …`、ピッカー）即座に `~/.joc/config.json` へ保存されます — 最新の選択が今後のすべてのセッションの `defaultModel` になり、`recentModels` が新しい順の MRU ローテーションを保持します。

```bash
bun install -g jeo-code
```

インストールの確認:

```bash
jeo --version
```

## 基本的な使い方

```bash
# 対話型コーディングエージェントを起動
jeo

# 1 回のリクエストをすぐ実行
jeo "README を整理してテストを実行して"

# 現在の設定とモデル接続状態を確認（実際の呼び出し経路で点検: Anthropic=GET /v1/models, OpenAI OAuth=Codex バックエンド, Gemini OAuth=Cloud Code Assist loadCodeAssist）
jeo doctor

# API キー / OAuth / ローカルモデルの設定
jeo setup
```

## 対話型スラッシュコマンド

`jeo` REPL の入力欄で使えるコマンドです（`<Tab>` 補完対応）。

| コマンド | 説明 |
| --- | --- |
| `/model [id\|#N\|save]` | モデルの設定（ライブ #N 選択・ファジーマッチ）。**選択は即座に自動保存** — 直近の選択がすべての新規セッションの既定値になり、`recentModels` が新しい順のローテーションを保持（引数なしの `/model` で表示）。`save` は明示的なエイリアスとして残存 |
| `/models [refresh\|caps\|catalog]` | ログイン済み OAuth/API モデルの一覧（+capability/カタログ表） |
| `/provider [name] [model\|#N]` | プロバイダーの認証情報・切替、当該プロバイダーのライブモデル一覧（会社名併記） |
| `/provider login <name>` | **入力欄から直接 OAuth ログイン**（anthropic/openai/gemini/antigravity; antigravity 推奨、gemini はフォールバック） |
| `/login [name]` · `/logout <name>` | OAuth ログインのエイリアス（`/provider login`）· 保存された OAuth トークンの削除 |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | サブエージェント（executor/planner/architect/critic）のロール別モデル/プロバイダー設定（保存と同時に現セッションの `task` 委任にも反映; モデル選択中でも role target を準備可能） |
| `/roles [tier model]` | モデルのロールティア（smol/slow/plan）の表示・設定 |
| `/thinking [level]` | 思考予算（minimal/low/medium/high/xhigh） |
| `/config` | 現在のランタイム設定を表示 |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan` など | ワークフロー skill の一覧・表示・実行 — `$team "タスク"` のように **`$スキル名` で直接呼び出し**（Codex/gjc スタイル、Tab 補完）（ユーザー SKILL.md は **明示的に呼び出したときのみ** 実行） |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | コードビュー / git diff / ファイル・パターン検索 |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | セッションの開始/削除/情報/名前変更/再開（gjc parity） |
| `/retry` · `/btw <question>` | 直前リクエストの再試行 · 履歴に触れずに横の質問 |
| `/export [path] [json]` · `/dump` | セッショントランスクリプトをファイルへ書き出し · クリップボードへコピー |
| `/usage` · `/context` · `/tools` · `/hotkeys` | 累積トークン使用量 · コンテキストトークンの内訳 · 公開ツール一覧 · ショートカット |
| `/theme [name]` · `/settings` | TUI テーマ（cosmic/matrix/solar/red-claw/blue-crab/mono）· ランタイム設定（=`/config`） |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | セッション・コンテキスト管理 |

## よく使うコマンド

```bash
# 保存済みセッションの表示 / 再開
jeo launch --list
jeo launch --resume

# tmux セッションで実行 — 実行ごとに独立したセッション（同じディレクトリ・ブランチで同時に複数起動しても base, base-2, base-3 … に分離）
jeo --tmux
jeo --tmux --model gemini-2.5-flash --thinking high
jeo --tmux --models --catalog gpt

# 別の worktree で実行
jeo --tmux --worktree ../jeo-work

# モデル一覧を確認
jeo models

# GJC スタイルのモデルカタログ（静的 capability）
jeo --list-models=gemini
jeo --models --catalog gpt

# 起動時にモデル/プロバイダー/思考予算を指定
jeo --model gemini-2.5-flash --thinking high "コードを分析して"
jeo --provider gemini --plan "実装計画を立てて"
# スラッシュコマンドパレット
# REPL で "/" や "/m" のように prefix を入力すると、カテゴリ別にコマンド/オプションが一覧表示されます。
# subagent の設定は /agents と /model subagent <role> ... で対応します。

# 認証管理
jeo auth login anthropic
jeo auth status
```

## Spec-first ワークフロー

要件をまず整理してから、計画・実行・検証まで進めるときに使います。各ステージは状態（`.joc/state/`）で引き継がれ、ゲートがあります: deep-interview がまず **トップレベルのトポロジを確認** し、入力言語（韓国語/英語/日本語/中国語）を保持して質問・評価・受け入れ基準を作成します。brownfield のリクエストなら **repo マーカー + path evidence** を収集したうえで、次に **シードを凍結**（ambiguity ≤ 20%; `--auto`/非 TTY もこのゲートを回避できず、基準未達ならシードは凍結されません）して初めて MutationGuard がコード編集を許可し、ralplan が進みます → ralplan は **Planner→Architect→Critic の合意**（3 段階の連鎖パス）で **承認待ち** プランを作成し（スキーマ自己検証・補正を含む）→ `jeo approve <plan>` で承認して初めて → team が実行します（破損した team 状態は無視せず拒否、未知の subagent role は実行前に拒否、同名の task も step index に基づき正しい role へルーティング、planner/architect/critic の report が契約を満たさない、または architect が `BLOCK`/`REQUEST CHANGES`、critic が `[REJECT]`/`[ITERATE]` を返したら即時中断）→ ultragoal が team 実行を検証します。

```bash
jeo deep-interview "作りたい機能の説明"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

## ローカルモデルの利用

Ollama を使えば API キーなしでローカル実行できます。

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor
jeo
```

## 設定ファイル

- グローバル設定: `~/.joc/config.json`
- プロジェクトの状態/セッション: `<project>/.joc/`

主な環境変数:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic        # TUI テーマ (cosmic/matrix/solar/red-claw/blue-crab/mono)
JEO_TUI_ALT_SCREEN=1        # レガシー alt-screen ライブターンに戻す（既定: メインバッファインライン + tmux ホイールスクロールバック）
JEO_STEP_EXTENSIONS=2       # ターンあたりの step 予算延長回数 (0 = 従来の固定カウンター)
JEO_STEP_EXTENSION_SIZE=10  # 延長 1 回あたりの付与 step 数（既定: 基本予算の半分、最小 4）
JEO_STEP_HARD_CAP=75        # 絶対 step 上限（既定: 基本予算の 3 倍）
JEO_STEP_WINDOW=8           # 進捗判定に使う直近ツール呼び出しウィンドウ
```

### Step 予算（retry フロー）

ターンあたりの step 制限は単純なカウンターではなく柔軟な **予算** です（gjc retry-flow パリティ）。カウンターが現在の上限に達すると、エンジンは直近のツール呼び出しウィンドウを採点し、実際に進捗していれば（直近呼び出しの 50% 以上成功 + 2 つ以上の異なる対象）予算を **自動で延長** します — `JEO_STEP_EXTENSIONS`（既定 2 回）と絶対上限 `JEO_STEP_HARD_CAP`（既定 3 倍）に制限され、`↻ step budget extended to M` のレジャー行とともにライブの `step N/M` 分母も更新されます。停滞したウィンドウ（ほとんど失敗、または同じ呼び出しの繰り返し）は延長されず **fail-fast** で統合ラップアップ（consolidation）に入り、却下理由が最終メッセージに明示されます。既存のガード（同一呼び出し 3 回、連続失敗 5 回、parse-bounce サルベージ）はそのままです。サブエージェント委任（`task`、`jeo team`）は正確な step 契約を維持します — 延長は無効で、リトライの権限は親にあります。

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
