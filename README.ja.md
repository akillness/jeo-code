<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun ベースの AI コーディングエージェント CLI — インタビュー、レビュー済みプラン、tmux ネイティブ実行、永続的検証。
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

実行中は gjc スタイルのフラットなインラインスタックとして描画されます。完了した作業は `✓/✗` の 1 行レジャーと枠付きツールカード（`bash` は `✗ Bash` タイトル、`$ command` エコー、`Output` デバイダー、出力本文、末尾の `Command exited with code N` を統合した単一のカード。`read`/`find`/`search` は単一の `✓ Read path:lines` 形式）としてスクロールバックに流れます。その下には、実際の処理対象を示すスピナー付きのステータス 1 行（`step` · 経過時間 · トークン数 · ライブの `$` コスト）、`Todos` チェックリスト、`◆ hud` 行、および背景色付きのモデルステータスバー（モデル名 (プロバイダー) · 思考中 / `branch ?N` ダーティフラグ / `cwd` · 出力トークンレート `⤴ N/s` · `ctx%`）がピン留めされます。アシスタントの返答は GFM テーブルを罫線による表としてレンダリングし、入力ボックス（`> Type your message...`、テーマアクセントカラーの枠、上部にモデルバーをピン留め）で `/` を入力すると、下部にコマンドのプレビュー（`(i/total)` の位置カウンター付き）が表示されます。

ステータス行は、ティックごとに変わる装飾テキストではなく、**いま実際に行っていること**（処理中のファイルやコマンド、アクティブな plan ステップ、plan の進捗、レート制限バックオフ中は `rate limited (HTTP 429) — auto-retry #2 in 4s` カウントダウン）を、現在のステップ経過時間とともに表示します。モデルの応答は**ライブストリーム**されます。JSON ツール呼び出しの作成中は思考プロセスが薄暗い `💭` 行として表示され、その後 `jeo · …` 行としてスクロールバックに一度フラッシュされます。**Ctrl+O** を押すと、最後の完全な応答（切り捨てなし、テーブル描画済み）を詳細ビューとしてスクロールバックにダンプできます。インラインのターンでは、進化のアイデンティティは最後の `Evolved to: …` サマリ 1 行に集約されます（ASCII アートのヘッダーは、レガシーの `JEO_TUI_ALT_SCREEN=1` ボックスモードに残ります）。`task` で委任された**サブエージェントの進捗**（割り当て、`step N/M`、ネストしたツール呼び出しの実際の対象である `read src/x.ts` や `bash: …`、結果のサマリ）も、gjc と同様にリアルタイムでストリーミング表示されます。

**クリップボード画像の貼り付け**: 入力ボックスで **Ctrl+V** を押すと、コピーした画像（スクリーンショット、ブラウザの右クリックでのコピーなど）を次のメッセージに添付できます。カーソル位置に `[image #N]` タグが挿入され、ボックスには `⧉ N image(s) attached` というヒントが表示されます。添付ファイルは、すべてのプロバイダー（Anthropic のコンテンツブロック、OpenAI のデータ URL、Codex の `input_image`、Gemini/Antigravity の `inlineData`、Ollama の `images[]`）に対して実際のマルチモーダル入力として送信されます。macOS では、`pngpaste` がインストールされていればそれが使用され（そうでない場合は AppleScript にフォールバックします）、Linux では `wl-paste`/`xclip` が使用されます。入力ボックス自体は、明るい上/左エッジと影付きの下/右エッジというツートーンの深度キューで描画されるため、フラットな枠線ではなく、立体的なパネルとして見えます。

**ツートーンのパネル深度**: すべての枠付きパネル（JEO forge ウェルカムボックス、ライブステータスボックス、ツール/forge カード、外枠フレーム、および入力ボックス）は、明るい上/左エッジ（テーマアクセント）と暗い下/右エッジ（淡色アクセント）で描画され、タイトルはコントラストを出すために太字になるため、ボックスはフラットな枠線ではなく立体的なパネルとして見えます。

**デフォルトは常に最新の選択に従う（全セッション共有）**: モデルまたはプロバイダーを選択すると（`/model …`、`/provider <name> …`、ピッカーなど）、即座に `~/.joc/config.json` に保存されます。最新の選択が今後のすべてのセッションの `defaultModel` になり、`recentModels` は新しい順（最新のものが最初）の MRU ローテーションを保持し、`/model` コマンドで一覧表示されます。

コマンド引数として 1 回限りのリクエスト（`jeo "request"`）を実行しても、TTY 上では同じライブ TUI が立ち上がり、`--no-tui`/パイプモードでは `[step N/M] <tool target>` と結果行がストリーミングされるため、処理全体の流れを確認できます。

TUI は、**メインのターミナルバッファにインラインで**ライブのターンをレンダリングします（gjc スタイル）。完了した進行状況の各行（ツールの実行結果、サブエージェントのイベント、思考プロセス）および終了した各ツールカードは、発生と同時に通常のスクロールバックにフラッシュされます。そのため、コンパクトなライブフレームが下部で再描画され続けている間も、**tmux やターミナルのマウスホイールを使用して、ターン中に過去の進行状況をスクロールバックして確認**できます。画面の消去は行単位（`ESC[2K` であり、スクロールバックをあふれさせる `ESC[0J` は決して使用されません）で行われ、各フラッシュと再描画は **DECSET 2026 同期更新** でラップされているため、ちらつきが発生しません。`JEO_TUI_ALT_SCREEN=1` を指定すると、従来のスクロールが分離された alt-screen でのターンに戻ります。全角文字の計算は全体を通じて **CJK/絵文字に対応** しており、マルチバイト文字の入力やボックス枠線がオーバーフローすることはありません。ストリーム/ツールリストは**固定サイズのリングバッファ**になっているため、長いセッションでもメモリおよびフレームあたりの描画コストは平坦に保たれます（要約 LLM が失敗した場合でも、履歴はトークナイザーの精度で決定的に圧縮され、無制限に増大することはありません）。画面が短くすべてのセクションが収まらない場合は、ライブフレームの上部がクリップされ、**ステータス行、Todos、hud、およびモデルバーが常に表示される**ように最優先で確保されます。

forge ボックスは枠線があるため、**ボックス全体が収まる場合のみ**（新しいもの優先）表示され、途中で切れた半分のボックスとして描画されることはありません。

## インストール

要件: Bun `1.3.14+`

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
jeo "Tidy up the README and run the tests"

# 現在の設定とモデル接続状態を確認（実際の呼び出し経路で点検: Anthropic=GET /v1/models, OpenAI OAuth=Codex バックエンド, Gemini OAuth=Cloud Code Assist loadCodeAssist）
jeo doctor

# API キー / OAuth / ローカルモデルの設定
jeo setup
```

## 対話型スラッシュコマンド

`jeo` REPL の入力ボックスで利用できるコマンド（`<Tab>` キーによる自動補完に対応しています）。

| コマンド | 説明 |
| --- | --- |
| `/model [id\|#N\|save]` | モデルの設定（ライブ `#N` 選択・ファジーマッチ）。**選択は即座に自動保存** — 直近の選択がすべての新規セッションの既定値になり、`recentModels` が新しい順の MRU ローテーションを保持（引数なしの `/model` で表示）。`save` は明示的なエイリアスとして残存 |
| `/models [refresh\|caps\|catalog]` | ログイン済み OAuth/API モデルの一覧（+capability/カタログ表） |
| `/provider [name] [model\|#N]` | プロバイダーの認証情報・切替、および当該プロバイダーのライブモデル一覧（会社名併記） |
| `/provider login <name>` | **入力ボックスから直接 OAuth ログイン**（anthropic/openai/gemini/antigravity; antigravity 推奨、gemini はフォールバック） |
| `/login [name]` · `/logout <name>` | OAuth ログインのエイリアス（`/provider login`）· 保存された OAuth トークンの削除 |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | サブエージェントのロール（executor/planner/architect/critic）用のモデル/プロバイダー設定。保存すると即座に現在のセッションの `task` 委任に適用されます。モデルを選択している間でもロールのターゲットを準備できます |
| `/roles [tier model]` | モデルのロールティア（smol/slow/plan）の表示・設定 |
| `/thinking [level]` | 思考予算（minimal/low/medium/high/xhigh） |
| `/config` | 現在のランタイム設定を表示 |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan`, etc. | ワークフロー skill の一覧・表示・実行。`$team "task"` のように **`$<skill>`** で直接呼び出し（Codex/gjc スタイル、Tab 補完）（ユーザーの SKILL.md は**明示的に呼び出したときのみ**実行） |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | コードビュー / git diff / ファイル・パターン検索 |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | セッションの開始/削除/情報/名前変更/再開（gjc 互換） |
| `/retry` · `/btw <question>` | 直前リクエストの再試行 · 履歴に影響を与えない横の質問 |
| `/export [path] [json]` · `/dump` | セッショントランスクリプトをファイルへ書き出し · クリップボードへコピー |
| `/usage` · `/context` · `/tools` · `/hotkeys` | 累積トークン使用量 · コンテキストトークンの内訳 · 公開ツール一覧 · ショートカット |
| `/theme [name]` · `/settings` | TUI テーマ（cosmic/matrix/solar/red-claw/blue-crab/mono）· ランタイム設定（=`/config`） |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | セッション・コンテキスト管理 |

## よく使うコマンド

```bash
# 保存済みセッションの表示 / 再開
jeo launch --list
jeo launch --resume

# tmux セッション内で実行 — 実行ごとに独立したセッション（同じディレクトリ・ブランチで同時に複数起動しても base, base-2, base-3 … に分離）
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
jeo --model gemini-2.5-flash --thinking high "Analyze this code"
jeo --provider gemini --plan "Draft an implementation plan"
# スラッシュコマンドパレット
# REPL で "/" や "/m" のように prefix を入力すると、カテゴリ別にコマンド/オプションが一覧表示されます。
# subagent の設定は /agents および /model subagent <role> ... でサポートされています。

# 認証管理
jeo auth login anthropic
jeo auth status
```

## Spec-first ワークフロー

要件をまず整理してから、計画・実行・検証まで進めるときに使います。各ステージは状態（`.joc/state/`）で引き継がれ、ゲートがあります。deep-interview がまず **トップレベルのトポロジを確認** し、質問、評価、受け入れ基準を作成する際に入力言語（韓国語/英語/日本語/中国語）を保持します。また、既存コードを変更するリクエスト（brownfield requests）の場合は **repo マーカー + path evidence** を収集します。次に、MutationGuard がコード編集を許可し ralplan が進む前に、**シードを凍結**（曖昧さ/ambiguity ≤ 20%。`--auto`/非 TTY はこのゲートを回避できず、基準が満たされない場合はシードは凍結されません）する必要があります。その後、ralplan は **Planner→Architect→Critic の合意**（スキーマの自己検証と補修を含む 3 段階の連鎖パス）によって **承認待ち** のプランを作成します。これは `jeo approve <plan>` で承認する必要があります。その後、team が実行します（破損した team 状態は無視されず拒否され、未知の subagent ロールは実行前に拒否され、同名のタスクはステップのインデックスに基づいて正しいロールにルーティングされます。また、planner/architect/critic のレポートが契約を満たさない場合や、architect が `BLOCK`/`REQUEST CHANGES` を返した場合、または critic が `[REJECT]`/`[ITERATE]` を返した場合は、実行が即座に停止します）。最後に、ultragoal が team の実行結果を検証します。

```bash
jeo deep-interview "Describe the feature you want to build"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

## ローカルモデルの利用

Ollama を使えば API キーなしでローカルで実行できます。

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor
jeo
```

## 設定ファイル

- グローバル設定: `~/.joc/config.json`
- モデルの選択は MRU で永続化されます: `defaultModel` は常に最新の選択になり、`recentModels` は最大 10 個の最近の ID を保持します（最新のものが最初）
- プロジェクトの状態/セッション: `<project>/.joc/`

主な環境変数:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic        # TUI テーマ (cosmic/matrix/solar/red-claw/blue-crab/mono)
JEO_TUI_ALT_SCREEN=1        # レガシーの alt-screen ライブターンに戻す (既定: メインバッファインライン + tmux ホイールスクロールバック)
JEO_STEP_BASE=24            # 動的ステップ予算: ローリングベース（`step N/M` の初期値）
JEO_STEP_EXTENSIONS=2       # ターンあたりの延長回数の制限（既定: 進捗している限り無制限、0 = 従来の固定カウンター）
JEO_STEP_EXTENSION_SIZE=10  # 1 回の延長あたりに付与されるステップ数（既定: ベースの半分、最小 4）
JEO_STEP_HARD_CAP=75        # 絶対ステップ上限（既定: 600 — タスクの停止ではなく、終了保証のみ）
JEO_STEP_WINDOW=8           # 進捗判定にスコア付けする直近のツール呼び出しウィンドウ
JEO_TMUX_MOUSE=0            # jeo 所有の tmux セッションでマウスモードを無効化（既定 on: ホイールアップで copy-mode に入り実スクロールバック履歴を閲覧）
JEO_TMUX_PROFILE=0          # 追加の tmux プロファイルを無効化（クリップボード連携 + copy-mode 選択の可読スタイル）
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

### Step 予算（ダイナミックリトライフロー）

ターンあたりのステップ制限は、ハードコードされたカウンターではなく、柔軟な**予算（budget）**です。デフォルトでは、この予算は**動的**です。ローリングベース（`JEO_STEP_BASE`、デフォルト 24）から開始され、直近のツール呼び出しウィンドウが実際の新しい進捗を示している限り（直近の呼び出しの 50% 以上が成功し、2 つ以上の異なるターゲットがあり、前回の延長以降に一度も実行されていない新しい呼び出しが少なくとも 1 つある場合）、予算自体を延長し続けます。タスクごとの固定の停止点はありません。`JEO_STEP_HARD_CAP`（デフォルト 600）は、異常な無限ループに対する終了保証としてのみ存在します。予算が延長されるたびに、`↻ step budget extended to M` というレジャー行が出力され、ライブ表示の `step N/M` 分母が更新されます。進行が停滞したウィンドウ（大部分が失敗しているか、すでに実行済みの呼び出しを繰り返している場合）は延長が拒否され、ループは**要約と整理（consolidation）**に入ります。ツールを使用しない最後のモデル呼び出しが 1 回実行され、達成されたこと、主要な発見、残されたタスクをまとめ、拒否の理由がメッセージに明示されます。明示的に `--max-steps N` を渡すと、制限されたフロー（ベース N ＋ 上限付きの延長）が復元されます。既存のガード（同一の呼び出しが 3 回、5 回連続の失敗、parse-bounce サルベージ）は変更されません。また、サブエージェントへの委任（`task` や `jeo team`）は正確なステップ契約を維持するため、そこでは延長は無効になり、リトライの管理は親エージェントが行います。

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
