<p align="center">
  <img src="assets/hero.png" alt="光る幻想的な風景に佇む jeo-code の赤いザリガニ魔法使いとぬいぐるみの仲間たち" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun ベースの AI コーディングエージェント CLI — インタビュー、レビュー済みプラン、ゲート付き実行、証拠に基づくチェック。
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
  <a href="https://buymeacoffee.com/akillness3q"><img alt="Buy Me a Coffeeで支援する" src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-AC6415?style=flat-square&logo=buy-me-a-coffee"></a>
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

- [双方向メッセンジャーゲートウェイ (Discord, Telegram, Slack)](docs/integrations/messenger.md)

**メッセンジャーゲートウェイ** — `jeo messenger` は通知デーモンとは別に、許可された Discord・Telegram・Slack の会話を扱います。Discord には明示的なローカル Docker サンドボックスが必須で、設定されたツールはホストのデスクトップ/シェルではなく Linux ゲストで実行します。[ガイド](docs/integrations/messenger.md)と以下の現行制約を参照してください。

📖 **[使い方ガイド](docs/usage-guide.md)** — インストール、TUI操作（↑履歴、Ctrl+O、`!`シェル）、スラッシュコマンド、`/resume`、スペックファーストワークフローをデモ動画付きで解説。

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> インライン再生されない場合は ▶ [デモ動画を再生/ダウンロード](docs/jeo-code-promo.mp4)。

## ハイライト

- **マルチプロバイダ・単一ループ** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio に加え、OpenAI・Anthropic 互換クラウド20以上(Groq、DeepSeek、Mistral、OpenRouter、xAI、Kimi、z.ai など)を均一な JSON ツールループで — **さらに自分で登録したエンドポイントも**: `jeo provider add --id my-proxy --base-url https://…`(または `--preset litellm|vllm|sglang|azure-openai|…`)で、LiteLLM プロキシ・自前ホストの vLLM・社内 Anthropic ゲートウェイが、組み込みの `openai` プロバイダを乗っ取ることなく独自のルーティング接頭辞・モデル一覧・認証情報を持てます。入力欄から OAuth ログイン(`/provider login`)、モデル選択は毎回新しいデフォルトとして永続化。プロンプトルーティングは実際に使える認証済み経路だけを自動選択します: Gemini OAuth は provider-qualified な `antigravity/*` エージェントセットへ、**アカウントが現在提供している構成のまま**向かい(ライブ検出 — 例: Gemini 3.6 Flash 各ティア、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6; チャット以外や非推奨の ID は除外され、一覧が空でも静的カタログで代用しません)、`GEMINI_API_KEY` が必要な public `google/gemini-*` 行は決して選びません。設定済みルートが未準備のプロバイダを指している場合、jeo はデフォルトへフォールバックする前に同等ティアの認証済みモデルへ切り替えます。
- **編集の完全性** — read 出力にコンテンツアンカー(`42ab|`)が付き、アンカー付き編集は現在のファイルと照合・行移動時は自動再マッピング・不一致時は最新内容と共に拒否されます。
- **自己修正の検証ループ** — post-edit フック(tsc / eslint / テスト)を設定すると、エージェントが診断を*自ら読み*ループ内で修正します。フックが赤のままだと `done` はブロックされます。
- **芝居のないゲート** — `ralplan` の合議はリポジトリを実際に読む critic サブエージェントで、`[OKAY]` 評決が永続化され `jeo approve` がそれを*要求*します。`ultragoal` はスイートをグローバル信号として1回実行し、基準ごとの合格を捏造しません。これはテストランナーの真正性やワークスペースの正しさを証明するものではありません。
- **クラッシュ耐久・ローカルファースト** — 全状態は `.jeo/` 配下にアトミック書き込み、プロセス間ロック、失敗タスクマーカー + 再開時の部分編集警告。
- **動的ステップ予算** — 直近のツール呼び出しが新規の進捗を示す間は延長され、停滞すれば要約に収束。サブエージェントは厳密なステップ契約を維持。
- **インライン TUI** — 完了した作業は実スクロールバックに流れ(ターン中も tmux ホイール可)、エージェント実行中も通常のクエリ入力欄が表示されたまま編集できます。Ctrl+O の詳細トグル、テーマ、クリップボード画像貼り付け(Ctrl+V)、CJK/絵文字対応の幅計算。
- **ブラウザツール** — Playwright によるヘッドレス Chromium 自動化を第一級のエージェントツールとして搭載: 名前付きタブを再利用しつつ `open`/`close`/`run`/`act`、スクリーンショットより `observe` でタグ付けした要素 id を優先。`act {verb:"verify", goal, ...}` はビジュアル QA ループを完結させます: ページをスクリーンショットし、独立したビジョン対応モデルに平易な言葉のゴールと照らして判定させ(`{verdict:"PASS"|"MISMATCH", detail}`)、人間(または同じエージェント)が保存済み PNG を目視確認する必要をなくします。`npx playwright install chromium` を一度実行する必要があります(バンドルされていません — jeo 自体はネイティブ依存ゼロのまま、ブラウザバイナリは Playwright 側の別ダウンロードです)。
- **蓄積されるスキル** — 行き詰まったターンは、その行き止まりをまさに同じスキルのプロジェクトレベルファイル(`.jeo/skills/<name>.md`、初回書き込み時にバンドルスキルからシード、決定論的なキーワードマッチ、LLM不使用)に書き込むようになりました。これにより次のセッションの `$<skill>` 呼び出しは、バンドルされたドキュメントが永遠に静的なままでいる代わりに、蓄積された「Known Failure Modes」/「Anti-Patterns」の知識を引き継ぎます。`jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"` で手動記録、`jeo skills eval <skill>` は記録済みの各教訓がスキルの現行ガイダンスでまだカバーされているか、それとも陳腐化したかを実際の LLM 判定で確認します。
- **低コスト層のグレーダールーティング** — `/goal` の検証器、`critic` サブエージェントロール、固定されていない `task` ファンアウトバッチは、採点・実行対象の作業と同じフルプライスモデルに黙って乗る代わりに、デフォルトで低コストのクレデンシャル済みモデルを使用します(`resolveVerifierModel`、ブラウザの `verify` アクションについてはビジョン対応能力でフィルタされ、テキストのみの低コストモデルが添付スクリーンショットを黙って取りこぼすことがありません)。
- **`jeo routine init`** — スケジュール/issue/PR トリガーで jeo をヘッドレス実行する(`jeo "<prompt>" -p`) GitHub Actions ワークフローを、GitHub 自身のランナー上に生成します — ラップトップは不要で、jeo 自体の内部に新しい攻撃対象領域も一切増えません(インプロセスのスケジューラや Webhook リスナーはありません)。`--dry-run` でプレビュー、`--no-pr` でデフォルトの実行ごとの PR の代わりに直接コミット。
- **リモート監視・制御(Telegram, Discord, Slack)** — ボットを一度ペアリング(`jeo notify setup --provider telegram|discord|slack`)すれば、共有の `jeo daemon start` 1 つが、稼働中のすべてのセッションにわたってサブエージェントの状態遷移(開始 → 完了/失敗/キャンセル)ごとにメッセージを送り、人間の許可リスト(allowlist)からの `/subagents`、`/steer`、`/cancel`(Discord/Slack ではさらに `/sessions` と `/send`)を受け付けます。Telegram はフォーラムトピック・インラインキーボード・画像添付に対応し、Discord は REST + Gateway WebSocket、Slack は Web API + Socket Mode を使います。プラットフォーム別詳細ガイドおよびインストール可能なエージェントスキル(`channel-notify`)を提供します。
- **範囲のあるワークフローゲートであり、証明ではない** — `approve` は承認対象の正確なプランダイジェストを再検証し、`team` はレビュー後にダイジェストが変わったプランを拒否します。`done` では現在のターンの変更・検証シグナルが完了をブロックまたは格下げし、`/goal` は会話・ツール履歴に対する別の LLM 判定と決定論的な証拠ゲートを追加します。いずれもワークスペースを独立して再読み込みしません。ツールやテストの出力は証拠であって、実行ランナーや結果の信頼性を証明するものではありません。このチェックはターン終了後にバックグラウンド処理がファイルを変更しないことも保証しません。`autopilot` ratchet はロールバック失敗を `rollback_failed` と記録し、非ゼロで停止します。
- **ターンをブロックしないセッション単位の非同期実行** — `task` ツールの実際の `tasks` 配列で独立した作業をファンアウトし、親ターンを止めません。detached サブエージェント、バックグラウンド job、行単位 monitor は後続ターンからも `subagent`/`job`/`monitor` の `list`、`inspect`、`await`、`cancel`、`tail` で制御できます。インライン TUI は各ワーカーのライブ activity を専用スロットに表示し、セッション終了または Ctrl-C ですべてのレジストリを破棄します。
- **プラン critic ゲート** — プランは architect/critic の工程を省略できません。`PlanSchema` は未検証の変更で終わるプランを拒否し(変更より前の verifier は対象にならない)、`ralplan` の作成時と `team`/`approve` の実行時に適用します。critic 評決には観測されたリポジトリ読み取り・検索の証拠が必要ですが、これはレビュー可能性を支えるものであり、ワークスペースの独立検証ではありません。
- **セーフティバウンダリの自動モデルフォールバック** — 未分類のセーフティ拒否(本物のコンテンツポリシー違反ではなく、分類器の誤検知の可能性)は、同じモデルで永遠に譲歩するのではなく、実際に別プロバイダのモデルへ切り替わるようになりました — 既存のレート制限時の高速フォールバックと同じパターンです。`Refusal (<category>)` 形式の確定的な拒否は影響を受けず、引き続きフォールバックなしでハードフェイルします。
- **メモリ: 勝ち取った信頼** — コンセプトの検証日付は、あらゆる書き込みではなく、蒸留パスが明示的に検証済みとマークした場合にのみ記録されるようになりました。`isConceptStale` は受動的なタイムスタンプを信頼する代わりに、未検証(または30日超の陳腐化)のコンセプトを再検証が必要なものとして扱います。
- **ダイナミックワークフロー(`eval` ツール)** — `task(role, taskText, context?)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`log(message)` で JS フローを構成します。セッションサンドボックスなしでは Worker スレッドのタイムアウトはセキュリティ境界ではありません。サンドボックスでは eval は Linux ゲストで実行され、task/parallel/pipeline の委任ヘルパーは非対応です。委任には親の `task` ツールを使ってください。
- **壊れた出力パイプで静かに終了** — 早期に読み取りを止めるコマンドへパイプした場合(`jeo --help | head`、消えたリモートピア)、生の `EPIPE` スタックダンプはもう発生しません — シェルが SIGPIPE で終了したパイプラインプロデューサに対して報告するのと同じコード(141)で静かに終了します。本物のクラッシュには影響せず、引き続き明確に表面化します。
- **macOS の低いファイルディスクリプタ上限警告** — 低い `ulimit -n`(BSD のデフォルト 256/1024)は、ファイル監視、ブラウザツール、広範なリポジトリスキャンで不明瞭な `EMFILE` 失敗を招くおそれがあります — jeo は起動時に一度(stderr のみ、パイプされる `-p` 出力を汚染しません)、具体的な `ulimit`/`launchctl` ガイダンスとともに警告するようになりました。`JEO_SKIP_NOFILE_CHECK=1` でオプトアウトできます。

## インストール

Bun `1.3.14+` が必要です。

```bash
bun install -g jeo-code
jeo --version
```


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
| `/provider add` · `list` · `remove` · `presets` | OpenAI/Anthropic 互換エンドポイントを正式なプロバイダとして登録(ゲートウェイプリセット15種) |
| `/agents [role]` · `/subagent` | ロール別(executor/planner/architect/critic)モデル・thinking・ステップ設定 |
| `/thinking [level]` | デフォルト推論予算(low…xhigh)の表示/設定 |
| `/route [status\|on\|off\|why\|history [n]]` | セッション単位のプロンプトベース・モデルルーティングの切替 · 直近のルーティング判断の説明 · `history [n]` はこのセッションの直近 n 件(デフォルト 10 件)のルーティング判断を表示(毎ターン、設定済み資格情報 — OAuth または API キー — が実際に提供するモデルの中からティアに適したモデルへ自動ルーティングし、設定済みルートが未準備なら同等ティアのモデルへ切り替え) |
| `/fast [on\|off\|status]` | 現在のモデルが low 推論をサポートする場合に fast thinking モードを切替 |
| `/skill` · `$<skill> [intent]` | ワークフロースキルの一覧/実行(`$team "task"` 形式) |
| `/view` · `/diff` · `/find` · `/search` | コード表示、git diff、ファイル/パターン検索 |
| `/computer [status\|on\|off]` | このセッションのフェイルクローズドなデスクトップ自動化ツールを切替 |
| `/new` · `/sessions` | 新しいセッションを開始、または保存済みセッションを一覧表示 |
| `/resume [id\|gajae:<session-id>[#<leaf>]] [--any-cwd]` | Jeo セッションを再開、または読み取り専用の正確なバージョンの GJC v5 ブランチを新しい Jeo セッションへインポート |
| `/changelog [--full]` · `/jobs [list\|tail\|await\|cancel]` | リリースノートを表示 · 現在のセッションのバックグラウンドジョブを確認・待機・キャンセル |
| `/history [n\|all]` · `/export` | 作業アクティビティ履歴を読みやすくスクロールバックへ再出力・トランスクリプト出力 |
| `/retry` · `/btw <q>` | 直前要求の再試行 · 履歴に残らないサイド質問 |
| `/usage` · `/context` · `/compact` | トークン使用量、コンテキスト内訳、手動コンパクション |
| `/theme` · `/config` · `/help` | テーマ、ランタイム設定、ヘルプ |

> [!CAUTION]
> **`/model <name>` で特定モデルを手動指定すると、そのセッション中ルーティングが固定されます。** プロンプトルーティング(`/route`)はモデルが手動固定されていない間のみ毎ターン再評価されます。`/model <name>` で特定モデルを選ぶとその選択が固定され、`/model auto`(ピンを完全に解除)を実行するか、`/route on`(ピンを消さずに優先度だけ上げる — `/route off` した瞬間ピンが復活)を実行するまでルーティングは切り替わりません。`roles.*` 未設定時に `defaultModel` へ確定フォールバックするのは `standard` ティアのみで、`high`/`complex` ティアは通常フォールバック前にライブでクレデンシャル済みの最強モデルを先に探索するため、未設定でも毎ターン別モデルに着地することがあります。**例外:** Antigravity または Gemini OAuth でクレデンシャルされたセッションは一つの資格情報で Anthropic/Google/OpenAI のモデルを再公開しており、その場合 `high`/`complex` は(必ずしも最強ではなく)会社ごとに1モデルへセッション単位で安定的に分散されるため、ターンごとに変わらずそのセッション中は固定されます。

### Antigravity アカウントモデルと公式 agy ブリッジ

**Cloud Code Assist (`antigravity/<CCA-id>`)** — `/model provider antigravity` と `/agents <ロール> provider antigravity` は、選択した jeo OAuth アカウントに対して Cloud Code Assist が返したモデルを表示します。ディスカバリーは `agentModelSorts`、`tieredModelIds`、`defaultAgentModelId` を統合し、アカウント別キャッシュは更新後も分離されます。空の一覧や取得失敗は静的カタログで置き換えず、そのまま報告します。CLI のモデルスラッグは CCA の通信上の ID ではなく、CLI で利用できても CCA 経由で Argon を直接呼び出せることを意味しません。

**CCA の例:** `jeo auth login antigravity` でそのアカウントのモデルを取得し、キャッシュします。`/model antigravity/<CCA-id>` または `/agents executor provider antigravity` で選択するか、`/model save antigravity/<CCA-id>` で既定値を保存します。

**公式 CLI (`agy/<official-cli-slug>`)** — `PATH` にインストールされた `agy` 実行ファイルを使う、別のフルエージェントバックエンドを明示的に選択します。認証は公式 CLI がサポートする独自の手順で行い、jeo はその認証情報を管理・取り込みしません。`agy models` が実際の一覧と正確なスラッグを提供し、静的カタログや CCA の別名は使いません。CLI のセッション・アカウントが jeo の OAuth アカウントと同一であるとは仮定せず、CLI のモデル一覧は jeo のアカウント別ディスクキャッシュではなく、現在のプロセス内にのみ保持します。空の一覧は空のまま、取得失敗はエラーとして報告し、モデルを捏造しません。

```sh
agy models
jeo launch --model agy/gemini-4-argon-low --plan --no-tui --no-session --no-skills "Explain this repository"
```

自分の CLI が実際に返したスラッグを使用してください。対話型 jeo セッションで一覧を表示して選択し、必要なら永続的な既定値として保存できます:

```text
/model provider agy
/model agy/gemini-4-argon-low
/model save agy/gemini-4-argon-low
```

> [!WARNING]
> **公式 agy エージェントが独自のツール・サンドボックス・権限・会話を管理します。jeo の承認はその内部ツール呼び出しを仲介しません。** `--plan` は CLI の計画モードを選ぶだけで、ツール承認を jeo に移しません。このブリッジは明示的な選択が必要なテキスト専用機能で、自動の生モデル・サブエージェントルーティングから除外されます。画像添付と、強制できない jeo 専用のツール・システム・ステップ数・thinking 制御は拒否します。

jeo のセッション保存が有効な場合、再開にはそのセッションに保存された CLI 会話 ID を使用し、無関係な CLI の最新会話は再開しません。キャンセルと期限付きタイムアウトは CLI ターンを停止します。選択した正確なモデルと、クォータエラーを含む上流 CLI のエラーを保持し、CCA・別のモデル・別のアカウントへ暗黙にフォールバックしません。

## CLI コマンド

`jeo --help` が正式な一覧です。よく使うものは次のとおり:

| コマンド | 用途 |
| --- | --- |
| `jeo [prompt] [--resume [id]] [--tmux] [--worktree <path>] [-p] [-q]` | 対話エージェント(デフォルト); `-p`/`--print` でヘッドレスのワンショット出力、`--worktree` で隔離された兄弟チェックアウト |
| `jeo setup` · `jeo auth login\|logout\|refresh\|status [provider]` · `jeo doctor` | プロバイダ、自動更新付き OAuth(PKCE)トークン、ライブ接続性 + 古いピンのチェック |
| `jeo provider list\|add\|remove\|presets\|test` | 名前付きカスタム OpenAI/Anthropic 互換プロバイダ(`/provider` と同じプランナー) |
| `jeo deep-interview` → `ralplan` → `approve` → `team` → `ultragoal` | Spec-first ワークフロー(後述); `jeo state <skill> read\|write\|clear\|handoff` でレシートを確認 |
| `jeo notify setup\|status\|health\|test` · `jeo daemon start\|stop\|status\|reload` | Telegram / Discord / Slack 通知と共有制御デーモン |
| `jeo autopilot <subcommand>` · `jeo ledger <subcommand>` | スコアラチェット付きの自律ビルドループ(`status` は方向、keep/revert 数、次アクションを表示) · プラン横断の追記専用台帳 |
| `jeo routine init …` | スケジュールまたはリポジトリイベントで jeo をヘッドレス実行する GitHub Actions ワークフローを生成 |
| `jeo skills list\|read\|sync\|lesson\|eval` | バンドル・ユーザー・プロジェクトのスキル; ドリフトチェック; 記録済みレッスン |
| `jeo mcp serve\|tools` · `jeo computer <action>` | 外部コントローラ向け MCP stdio サーバー · デスクトップ自動化アクション |
| `jeo session list\|attach\|rm` · `jeo export [id]` · `jeo chat "<msg>"` | tmux セッション管理 · トランスクリプト出力 · ツールなしのストリーミングチャット |
| `jeo update [--check]` · `jeo whats-new` · `jeo memory-migrate` | npm からの自己更新 · バンドルされたリリースノート · レガシー `MEMORY.md` → OKF バンドル |

## Spec-first ワークフロー

要件 → プラン → 承認 → 実行 → 検証を `.jeo/state/` で管理します。各段階のゲートは該当処理をブロックできますが、すべての引き継ぎや完了結果の正しさを保証するものではありません。

```bash
jeo deep-interview "作りたいものを説明"
jeo ralplan
jeo approve <プランパス>
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
  │      ultragoal       │  証拠に基づく報告 — スイート1回、基準の合格を捏造しない
  └──────────────────────┘
```

- **deep-interview** — 曖昧度スコアリングのソクラテス式ループ。基準が具体的な場合のみシードを凍結(曖昧のみの基準は拒否)、シードは自身のパーサをラウンドトリップで通過する必要があります。新しいアイデアが完了済みインタビューを黙って再利用することはありません。
- **ralplan** — ドラフトパス + **リポジトリを実際に読む critic サブエージェントゲート**: `[OKAY]`/`[ITERATE]`/`[REJECT]` 評決が強制・永続化されます。無効なプラン(スキーマ・未知ロール)は complete になりません。
- **approve** — `team` が実行する契約(スキーマ+ロール)を検証し、永続化された `[OKAY]` 評決まで要求します。
- **team** — レビュー済みのステップをプロセス間ロックの下で実行します。同じ `parallel_group` を持つ連続ステップは別々の Git worktree で並列実行し、順にマージします。タスク契約、変更監査、失敗マーカーで未完了の作業を明示します。
- **ultragoal** — 証拠に基づく報告: スイートはグローバル信号として1回実行され、基準ごとの合格は捏造されません。テストランナーが本物か、ワークスペースが目標を満たすかを証明するものではありません。

`/goal` は会話と記録されたツール履歴を別の LLM 呼び出しで判定し、現在ターンの変更と新しい検証シ그ナルを決定的にゲートします。ワークスペースを再読したりテスト出力の真正性を確認したりはせず、launch の完了ゲートは実行中のバックグラウンドジョブも検査しません。

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

### プロンプト・ターンフックとユーザーレジストリ

ツールループのイベントに加えて、ターンごとに 1 回発火するイベントが 2 つあります:

| イベント | タイミング | ペイロード(stdin JSON) | フック出力 |
| -------- | ---------- | ---------------------- | ---------- |
| `pre-prompt` | 入力したプロンプトをモデルが見る前 | `{event, hook_event_name: "UserPromptSubmit", session_id, cwd, prompt}` | stdout のテキスト、または JSON の `hookSpecificOutput.additionalContext` / `additionalContext` / `context` が `[pre-prompt hook context]` ブロックとしてプロンプトメッセージの末尾に付加されます(プロンプトカードと履歴タイトルにはユーザー自身の言葉だけが残ります) |
| `turn-end` | 最終返信の直後 | `{event, hook_event_name: "Stop", session_id, cwd, prompt, response, last_assistant_message, done, steps, model}` | 無視 |

どちらも助言(advisory)扱いです: 非ゼロ終了・タイムアウト・中断は通知を出すだけでプロンプトをブロックしません(既定タイムアウト 10 秒 / 30 秒)。`$skill` 実行とメッセンジャー literal セッションはスキップされ、`agy/` モデルでは公式 CLI がプロンプトを管理するため `pre-prompt` はスキップされ、`turn-end` は実行されます。`pre-tool` フックは exit 0 で `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}` を出力して拒否(`ask` は deny 扱い)したり、`additionalContext` を出力してそのツール結果に付加したりできます。通常の stdout は引き続き無視されます。すべてのペイロードに `hook_event_name`、`session_id`、`cwd`(ツールイベントは `tool_name`/`tool_input` も)が含まれるため、Claude Code / Codex のフックスクリプトをそのまま使えます — ホストセッションのみで、サンドボックスのフックは従来のペイロードを受け取ります。

**ユーザーレジストリ.** `~/.jeo/hooks.json`(`.jeo/hooks.json` と同形式、`JEO_CONFIG_DIR` に従う)は、jeo-skills のプロンプトルーティングやナレッジパイプラインのようにフックを代わりに設置するツール向けのフック専用ファイルで、認証情報が書き換えられないよう `config.json` から分離されています。優先順位: `config.json` の `"hooks": { "enabled": false }` はすべてを無効にし、プロジェクト `.jeo/hooks.json` の `"enabled": false` はそのプロジェクトだけを除外し、それ以外は `hooks.enabled: true` なしでレジストリが設定済みフックより先に実行されます。プロジェクト自身の `hooks` リストは `config.json` のリストだけを置き換えレジストリは置き換えず、プロジェクト / `config.json` のフックは従来どおり `hooks.enabled: true` のときだけ実行されます。サンドボックスセッションはレジストリをスキップします。

`jeo doctor` は現在実行されるフックを `[hooks]` 行(`--json` では `hooks`)で表示し、レジストリ/プロジェクトファイルが読めない、エントリが不正で無視された、グローバルスイッチやプロジェクトのオプトアウトがすべてを止めている場合に警告します。

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

## リモート監視・制御(Telegram, Discord & Slack)

オプトイン: 共有デーモン 1 つがマシン上の稼働中の `jeo` セッションをすべて監視し、**サブエージェントの状態遷移**(開始 → 完了/失敗/キャンセル)ごとにメッセージを送ります。加えてセッション識別ヘッダー、ターンの開始/終了サマリー、確定したターンのテキストも送りますが、「まだ実行中」という繰り返しの ping は決して送りません。allowlist に登録された人間はチャットから一覧・送信・ステア・キャンセルができ、すべての制御はローカルセッションへ中継されて **確認応答済み(受理であって完了ではない)** または **未確認応答** として報告されます — デーモンがコマンドの実行完了を主張することはありません。

### Discord セッションとサンドボックス境界

Discord の1スレッドは送信者・メッセージに関係なく1つの永続セッションを保持します。同じスレッドは FIFO、別セッションは並行実行できます。選択したワークスペースを共有し、セッション別の Git worktree は作らないため、ファイル変更は競合し得ます。

メッセンジャー設定に `sandbox` を指定します。`~/.jeo/config.json` にも同じ形式で設定すると、ターミナルセッションを隔離します:

```json
{
  "sandbox": {
    "image": "oven/bun:1.3.14",
    "limits": { "memoryBytes": 268435456, "pids": 64, "cpus": 1 }
  }
}
```

これは完全なメッセンジャープロファイルではなくサンドボックス部分です。既存の `platforms` 許可リストと認証情報の環境変数名は保持してください。Linux Bun イメージはローカル Docker デーモンに既に存在する必要があります。不変のイメージ ID を確認して `--pull=never` で起動し、pull・依存関係インストール・リモート Docker・ホスト実行へのフォールバックは行いません。Mac/Windows でもホストシェルではなく **Linux ゲストシェル**です。ネットワークは `none`、`/workspace` は読み書き可能、追加パスにはセッション別 `ro`/`rw` 許可が必要です。ホーム全体・非公開制御パス・制御ソケットは許可できません。ホスト運用者と Docker デーモンは信頼対象です。

アクセスを決定できるのは親に直接提出された人間の `/sandbox status`、`/sandbox approve <requestId>`、`/sandbox deny <requestId>`、`/sandbox revoke` のみです。モデルの `sandbox_request {host, mode:'ro'|'rw'}` は要求専用で、自己承認できません。認証済み主体自身のセッションと現在の要求 revision が必要で、古い要求や別セッションの要求は拒否します。既存ターミナルの Discord 制御にもサンドボックスが必要です。ローカル `/discord control on --allow-full-control` で有効、`/discord control off` で無効にし、リモートターンはローカル入力の下書きを保持します。

`independentSessions` は実行時に拒否し、明示的な `jeo messenger setup` 移行で削除します。`sessionDir` はワークスペースと重ならない外部の非公開パスに置いてください。旧 `.jeo/sessions`・`.jeo/messenger-sessions`・`.jeo/memory/raw` の記録がワークスペースにある場合は移動案内とともに起動を拒否します。再起動前に意図的に移動し、自動コピー・削除は行いません。完全な会話履歴は親専用ストアに保持し、蒸留済みプロジェクト学習は共有します。既存 ECC スキル/ワークフロー導入を再利用し、グローバル再インストールは行っていません。保護されたグローバルスキルは実行前にスナップショット化し、ワークスペース/許可済み文書はゲスト経由で読みます。

**検証範囲(2026-11-03):** 実際の macOS 実 Docker 検証(`bun run verify:sandbox`)が **20動作契約**に成功し、ソースのスタンドアロンビルドも成功しました。コピーしたスタンドアロンバイナリは、実 PTY FIFO、親の `sandbox_request` と実 Linux ゲストツール、全履歴の非公開、親が生成した stderr シャットダウン nonce と一致する ACK、実ワーカー終了(143)、Docker コンテナ不在を対象とする限定的な検証に成功しました。現在のソースラッパーは teardown のクリーンアップ所有者、有界なシャットダウン待機、人間によるセッション別許可、永続スレッド/FIFO 1 つ、共有ワークスペースを維持します。これは全スイート・クロスプラットフォーム・本番の検証ではありません。全体の `bun test` はタイムアウトし**成功ではなく**、一般の集中スイートには古いフィクスチャの失敗が残り修正中です。ネイティブ Linux・Windows ホストの検証は利用できず、実 Discord 送信も行っていません。macOS 上の Linux ゲストはホスト認定ではありません。`bun run build:hands` はワーカーをビルドし、`bun run verify:sandbox` は前提条件をインストールせず実 Docker を検査します。ワーカー/コンテナの除去確認が必要で、エラーや未確認の除去を成功と報告しません。

プラットフォーム別詳細ガイド:
- 📖 [チャネル連携概要 & アーキテクチャ](docs/integrations/README.md) — 機能マトリクスと全体構成
- 📱 [Telegram 連携詳細ガイド](docs/integrations/telegram.md) — 内蔵バックグラウンドデーモン、BotFather ペアリング、フォーラムトピック、`/steer` コマンド
- 🎮 [Discord 連携詳細ガイド](docs/integrations/discord.md) — 即時チャネル通知用 Webhook、双方向対話ボット、Embed カード形式
- 💬 [Slack 連携詳細ガイド](docs/integrations/slack.md) — ワークスペース通知用 Incoming Webhook、チーム共同作業用 Slack App / Socket Mode、Block Kit カード
- 🧩 [エージェントスキルインストールガイド](docs/integrations/agent-skills.md) — `jeo`、Claude Code、Cursor、Codex などへチャネル通知スキルを導入

```bash
jeo notify setup  [--provider telegram|discord|slack] [--token-env NAME] [--app-token-env NAME] [--chat-id ID | --channel-id ID] [--allowed-user-ids ID,ID,...]
jeo notify status [--provider …]   # マスク済みトークン、宛先、allowlist、デーモン状態(stopped / stale / initializing / initialized / pairing)
jeo notify health [--provider …]   # 読み取り専用: ボット ID + 宛先アクセス、何も送信しない
jeo notify test   [--provider …]   # 実際のテストメッセージを 1 件送信
jeo daemon start|stop|status|reload   # 共有デーモンにプロバイダ選択はない
```

| | Telegram(デフォルト) | Discord | Slack |
| --- | --- | --- | --- |
| 認証情報 | ボットトークン(`JEO_TELEGRAM_BOT_TOKEN` または `--token-env`) | ボットトークン(`JEO_DISCORD_BOT_TOKEN` または `--token-env`)+ **Message Content** インテント | ボット `xoxb` トークン(`JEO_SLACK_BOT_TOKEN` または `--token-env`)+ アプリ `xapp` トークン(`SLACK_APP_TOKEN` または `--app-token-env`)、Socket Mode 有効化 |
| 宛先 | チャレンジペアリングによるプライベートチャット(表示された `/start jeo_<code>` を 120 秒以内にボットへ送信)または明示的な `--chat-id`; グループは `--allowed-user-ids` が必要 | 明示的な `--channel-id`(テキストチャネル、DM、アナウンス、または既存スレッド) | ボットが参加済みの明示的な `--channel-id`(`C…`); ワークスペースはトークンのチームに固定 |
| allowlist | プライベートチャットでは任意、グループでは必須 | 必須(人間のユーザー ID; ボットは無視) | 必須(人間のユーザー ID) |
| トランスポート | Bot API `getUpdates` の直接ロングポール、ボットトークンごとにポール所有者 1 つ | 送信は REST、受信は Gateway WebSocket | 送信は Web API、受信は Socket Mode WebSocket |
| 追加機能 | フォーラムトピック、インラインのキャンセルボタン、画像添付、任意のセッション単位トピック(`notifications.telegram.perSessionTopics`、Threaded Mode のプライベートチャットのみ) | セッション通知に返信するとそのセッションへテキスト送信(24 時間) | セッション通知のスレッド内で返信するとそのセッションへテキスト送信(24 時間); 登録済み Slack スラッシュコマンドと `@bot /command` のどちらも使用可 |
| コマンド | `/subagents` `/steer <session> <subagent> <msg>` `/cancel <session> <subagent>` `/help` | `/sessions` `/subagents` `/send <session> <text>` `/steer …` `/cancel …` `/help` | Discord と同じ |

用語の意味 — これらは互いに置き換えられません:

- **セットアップ**は公式 API(Telegram `getMe`、Discord のボット + チャネル検索、Slack `auth.test`/`bots.info`/`conversations.info` と Socket Mode URL)でボット ID と宛先アクセスを検証し、結果を `~/.jeo/config.json` の `notifications.<provider>` 配下に **平文** で保存します — このファイルは非公開に保ってください。メッセージは送信せず、ソケットも開きません。
- **`initialized`**(`jeo daemon status`)はデーモンプロセスがロックを所有しトランスポートを起動したことを意味し、Telegram ポール、Discord Gateway ハンドシェイク、Slack Socket Mode 接続が成功した証明ではありません。それには `notify health` / `notify test` を使ってください。
- **トークンや宛先を変更する**と、Discord と Slack では allowlist が(`--allowed-user-ids` を再度渡す必要があります)、Telegram ではセッション単位トピックのマップがリセットされます。まったく同じ認証情報と宛先でセットアップを再実行した場合は保持されます。
- **リモートコマンドはリテラルテキスト**(`/subagents` など)で、設定済みチャット/チャネルと allowlist に対して認可されます。Slack は同名の登録済みスラッシュコマンドも受け付けます。Discord ターミナル制御は既定で無効です。サンドボックスセッションでローカル `/discord control on --allow-full-control` により有効化し、`/discord control off` で解除します。上記の隔離・人間の承認境界に従い、認証情報をチャットに書かないでください。
- **再試行はプロバイダごとに上限あり**: Telegram は 429 の `retry_after` クールダウン(1 秒〜1 時間にクランプ)を尊重し、ポールのバックオフは別途管理します。Discord と Slack は 429 時にサーバーの `Retry-After` を使って最大 3 回まで再試行し、結果が不明な POST を再送することはありません(プラットフォーム側がすでに受理している可能性があるため)。
- **オーファン復旧**: デーモンがクラッシュするとロックは `stale` になり、次の `jeo daemon start` が回収します。`jeo daemon stop` は、ホストがプロセス起動時刻を報告できる場合は再利用された PID へのシグナル送信を拒否し、報告できない場合はその旨を伝えます。
- **これまでの検証状況**: Telegram はエンドツーエンドで検証済み(実送信、ポーリング、クリーンシャットダウン)。Discord と Slack は同じデーモンの背後に実装され、オフラインのトランスポート/配線テストとコード・セキュリティ・型レビューを経ていますが、実際のボット/アプリ認証情報を使ったライブ接続はまだ行っていません。

```
┌─────────────────────┐        ┌──────────────────┐        ┌───────────────────────────┐
│   interactive turn  │◄──ws──►│  notify daemon   │◄──────►│ Telegram Bot API (poll)   │
│  SubagentRegistry   │  (one  │   (singleton)    │        │ Discord REST + Gateway WS │
│  session endpoint   │  per   │                  │        │ Slack Web API + Socket WS │
└─────────────────────┘ session└──────────────────┘        └───────────────────────────┘
```

### Discord & Slack (Webhook & ボットアプリ)

チームのワークスペース通知用に環境変数を設定します:

```bash
# Discord Webhook
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Slack Incoming Webhook
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

タスク実行状況、所要時間、コミットおよび PR リンクを含むリッチな Embed(Discord) や Block Kit カード(Slack) を送信できます。ペイロード形式や CI 自動化スニペットは [Discord ガイド](docs/integrations/discord.md) および [Slack ガイド](docs/integrations/slack.md) をご覧ください。

### エージェントスキルとしてのインストール

標準の [Agent Skills](https://agentskills.io) CLI を使用して、`jeo` やその他の AI コーディングエージェントに通知スキルを追加できます:

```bash
# 現在のリポジトリに channel-notify スキルをインストール:
npx skills add akillness/jeo-code --skill channel-notify

# または全プロジェクト共通で使えるようグローバル(-g)にインストール:
npx skills add akillness/jeo-code --skill channel-notify -g
```

インストール後はエージェントがタスク実行中に自動で進捗を通知します:
```bash
# jeo でのワンショット実行:
jeo $channel-notify "全47件のテストにパスしました。レビュー準備完了。"

# Claude Code での実行:
/channel-notify "ビルド成功。PR: https://github.com/..."
```

## ルーティン(GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

GitHub Actions ワークフロー(`.github/workflows/<name>.yml`)を生成し、GitHub ホステッドランナーで jeo をインストールして `schedule` / `issues` / `pull_request` によりヘッドレス実行します(`jeo "<prompt>" -p`)。手動実行用 `workflow_dispatch` も含みます。トリガーは GitHub が担い、ルーティンはプロセス内スケジューラや Webhook リスナーを追加しません。セッションサンドボックスは上記ローカル前提条件を伴う別の明示的設定で、ルーティン生成がインストールするものではありません。既定は変更の PR 作成(`peter-evans/create-pull-request`、空 diff は no-op)、`--no-pr` はトリガーブランチへコミットします。`--dry-run` は YAML 出力のみ、既存 `--out` の上書きには `--force` が必要です。最初の実行前にリポジトリシークレット `ANTHROPIC_API_KEY`(または `--api-key-env <VAR>`)を設定してください。

## ローカルモデル

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 設定

- グローバル設定: `~/.jeo/config.json`(モデル選択は MRU 永続)
- プロジェクト状態: `<project>/.jeo/`。サンドボックスの会話記録はワークスペース外に保持します(上記 Discord セッション境界を参照)。

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

### カスタムプロバイダ

```jsonc
{
  "customProviders": {
    "my-proxy": {
      "baseUrl": "https://gateway.internal/v1",
      "protocol": "openai",            // または "anthropic" (/v1/messages ワイヤ形式)
      "apiKeyEnv": "MY_PROXY_API_KEY", // 既定: <ID>_API_KEY
      "models": ["fast", "smart"]      // オフライン一覧。ライブ /models が優先されます
    }
  }
}
```

シェル(`jeo provider add|list|remove|presets|test`)からも入力欄(`/provider add …`)からも
同じレジストリを扱えます。`jeo provider test <id>` はエンドポイントを実際に叩き、
**認証情報の問題とエンドポイントの問題を分けて**報告し、失敗時は非ゼロ終了するため
プロビジョニングスクリプトのゲートに使えます。

### サブエージェントのファンアウト並列度

```jsonc
{ "subagentConcurrency": 2 }   // 既定 4、1〜16 にクランプ
```

Anthropic の Tier-1 アカウントでは同時ストリーム4本で即座にレートリミットに達し、
ファンアウトが逐次実行より*遅い*バックオフの嵐になります。制限の厳しいアカウントでは
下げ、余裕があれば上げてください。`task` ツールの `tasks[]` バッチと `eval` ツールの
`parallel`/`pipeline` ヘルパーの両方に効きます。

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

CI は `.github/workflows/npm-publish.yml` で公開します — GitHub リリース公開時に自動、または `workflow_dispatch` の手動実行(ドライラン可)。ワークフローはブラウザのハードゲート・型チェック・テスト(ブラウザツールのテストは別プロセス)・`pack:check`・パック済み tarball の起動スモークを経て `npm publish --provenance` を実行します。

公開には **npm trusted publishing(OIDC)** を使います — ローテーション・漏洩・2FA 免除が必要な `NPM_TOKEN` シークレットは存在しません(npm は 2026 年 8 月から 2FA バイパストークンを制限し、2027 年 1 月にそのトークンによる直接公開を終了します)。npmjs.com での一度きりの設定: パッケージ `jeo-code` → Settings → Trusted Publisher → GitHub Actions、owner `akillness`、repository `jeo-code`、workflow `npm-publish.yml`、environment は空欄。ジョブには `permissions.id-token: write` と npm ≥ 11.5.1 が必要です(ワークフローが npm 自体を更新します)。

## 謝辞 (Acknowledgements)

[gajae-code](https://github.com/Yeachan-Heo/gajae-code) に多大な感謝を。

## 変更履歴 (Changelog)

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[Unreleased]**
- **[0.12.24]** (2026-11-06)
- **[0.12.23]** (2026-11-06)
- **[0.12.22]** (2026-11-04)
- **[0.12.21]** (2026-11-04)

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
