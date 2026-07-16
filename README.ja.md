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
- **ブラウザツール** — Playwright によるヘッドレス Chromium 自動化を第一級のエージェントツールとして搭載: 名前付きタブを再利用しつつ `open`/`close`/`run`/`act`、スクリーンショットより `observe` でタグ付けした要素 id を優先。`act {verb:"verify", goal, ...}` はビジュアル QA ループを完結させます: ページをスクリーンショットし、独立したビジョン対応モデルに平易な言葉のゴールと照らして判定させ(`{verdict:"PASS"|"MISMATCH", detail}`)、人間(または同じエージェント)が保存済み PNG を目視確認する必要をなくします。`npx playwright install chromium` を一度実行する必要があります(バンドルされていません — jeo 自体はネイティブ依存ゼロのまま、ブラウザバイナリは Playwright 側の別ダウンロードです)。
- **蓄積されるスキル** — 行き詰まったターンは、その行き止まりをまさに同じスキルのプロジェクトレベルファイル(`.jeo/skills/<name>.md`、初回書き込み時にバンドルスキルからシード、決定論的なキーワードマッチ、LLM不使用)に書き込むようになりました。これにより次のセッションの `$<skill>` 呼び出しは、バンドルされたドキュメントが永遠に静的なままでいる代わりに、蓄積された「Known Failure Modes」/「Anti-Patterns」の知識を引き継ぎます。`jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"` で手動記録、`jeo skills eval <skill>` は記録済みの各教訓がスキルの現行ガイダンスでまだカバーされているか、それとも陳腐化したかを実際の LLM 判定で確認します。
- **低コスト層のグレーダールーティング** — `/goal` の検証器、`critic` サブエージェントロール、固定されていない `task` ファンアウトバッチは、採点・実行対象の作業と同じフルプライスモデルに黙って乗る代わりに、デフォルトで低コストのクレデンシャル済みモデルを使用します(`resolveVerifierModel`、ブラウザの `verify` アクションについてはビジョン対応能力でフィルタされ、テキストのみの低コストモデルが添付スクリーンショットを黙って取りこぼすことがありません)。
- **`jeo routine init`** — スケジュール/issue/PR トリガーで jeo をヘッドレス実行する(`jeo "<prompt>" -p`) GitHub Actions ワークフローを、GitHub 自身のランナー上に生成します — ラップトップは不要で、jeo 自体の内部に新しい攻撃対象領域も一切増えません(インプロセスのスケジューラや Webhook リスナーはありません)。`--dry-run` でプレビュー、`--no-pr` でデフォルトの実行ごとの PR の代わりに直接コミット。
- **リモートサブエージェント可視化(Telegram)** — ボットを一度ペアリング(`jeo notify setup`)すれば、`jeo daemon start` がサブエージェントの状態遷移(開始 → 完了/失敗/キャンセル)ごとにメッセージを送り、`/subagents`、`/steer <id> <subagentId> <msg>`、`/cancel <id> <subagentId>` を受け付けます。Telegram フォーラムトピック、インラインキーボード、画像添付を含む `gjc` 完全パリティを提供し、コマンドはペアリングされたチャットのみ許可されます。
- **独立した検証者、実際に強制** — プランはもう architect/critic ステップをスキップできません: `PlanSchema` は未検証の変更で終わるプランを拒否し(検証対象の変更より前に置かれた verifier も無効)、`ralplan` のドラフト時点と `team`/`approve` の実行時点の両方で適用されます。すべての architect/critic 評決も実際の証拠を示す必要があり、観測された `read`/`search`/`find`/`ast_grep`/`lsp` 呼び出しがゼロなら、テキストが何を主張していても評決はブロックされます。
- **セーフティバウンダリの自動モデルフォールバック** — 未分類のセーフティ拒否(本物のコンテンツポリシー違反ではなく、分類器の誤検知の可能性)は、同じモデルで永遠に譲歩するのではなく、実際に別プロバイダのモデルへ切り替わるようになりました — 既存のレート制限時の高速フォールバックと同じパターンです。`Refusal (<category>)` 形式の確定的な拒否は影響を受けず、引き続きフォールバックなしでハードフェイルします。
- **メモリ: 勝ち取った信頼** — コンセプトの検証日付は、あらゆる書き込みではなく、蒸留パスが明示的に検証済みとマークした場合にのみ記録されるようになりました。`isConceptStale` は受動的なタイムスタンプを信頼する代わりに、未検証(または30日超の陳腐化)のコンセプトを再検証が必要なものとして扱います。
- **ダイナミックワークフロー(`eval` ツール)** — サブエージェントディスパッチの周りに実際の JS 制御フローを書けます: `task(role, taskText, context?)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`log(message)` を組み合わせ、`task` の単一ステージ `tasks[]` バッチでは表現できない逐次/分岐オーケストレーションを構成します。隔離された Worker スレッドで、真のプリエンプティブなタイムアウト(同一プロセス内のレースではなく `worker.terminate()`)を伴って実行され — `bash` と同じフルプロセスの信頼度で、サンドボックスのふりはせず、同じ interview 変更ロックでゲートされます。
- **壊れた出力パイプで静かに終了** — 早期に読み取りを止めるコマンドへパイプした場合(`jeo --help | head`、消えたリモートピア)、生の `EPIPE` スタックダンプはもう発生しません — シェルが SIGPIPE で終了したパイプラインプロデューサに対して報告するのと同じコード(141)で静かに終了します。本物のクラッシュには影響せず、引き続き明確に表面化します。
- **macOS の低いファイルディスクリプタ上限警告** — 低い `ulimit -n`(BSD のデフォルト 256/1024)は、ファイル監視、ブラウザツール、広範なリポジトリスキャンで不明瞭な `EMFILE` 失敗を招くおそれがあります — jeo は起動時に一度(stderr のみ、パイプされる `-p` 出力を汚染しません)、具体的な `ulimit`/`launchctl` ガイダンスとともに警告するようになりました。`JEO_SKIP_NOFILE_CHECK=1` でオプトアウトできます。

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
| `/route [status\|on\|off\|why\|history [n]]` | セッション単位のプロンプトベース・モデルルーティングの切替 · 直近のルーティング判断の説明 · `history [n]` はこのセッションの直近 n 件(デフォルト 10 件)のルーティング判断を表示(設定済み資格情報 — OAuth または API キー — が実際に提供するモデルの中でのみ自動ルーティング) |
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
> **`/model <name>` で特定モデルを手動指定すると、そのセッション中ルーティングが固定されます。** プロンプトルーティング(`/route`)はモデルが手動固定されていない間のみ毎ターン再評価されます。`/model <name>` で特定モデルを選ぶとその選択が固定され、`/model auto`(ピンを完全に解除)を実行するか、`/route on`(ピンを消さずに優先度だけ上げる — `/route off` した瞬間ピンが復活)を実行するまでルーティングは切り替わりません。`roles.*` 未設定時に `defaultModel` へ確定フォールバックするのは `standard` ティアのみで、`high`/`complex` ティアは通常フォールバック前にライブでクレデンシャル済みの最強モデルを先に探索するため、未設定でも毎ターン別モデルに着地することがあります。**例外:** Antigravity または Gemini OAuth でクレデンシャルされたセッションは一つの資格情報で Anthropic/Google/OpenAI のモデルを再公開しており、その場合 `high`/`complex` は(必ずしも最強ではなく)会社ごとに1モデルへセッション単位で安定的に分散されるため、ターンごとに変わらずそのセッション中は固定されます。

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

## ルーティン(GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

GitHub Actions ワークフロー(`.github/workflows/<name>.yml`)を生成し、jeo をインストールして `schedule` / `issues` / `pull_request` でヘッドレス実行します(`jeo "<prompt>" -p`) — 手動テスト実行のために常に `workflow_dispatch` と組み合わせます — GitHub 自身のホステッドランナー上で。これが jeo の「ラップトップなしで動く」ストーリーです: jeo 自体の内部にインプロセスのスケジューラも、Webhook リスナーも、コード実行サンドボックスもありません — GitHub のインフラがトリガーを担い、jeo は既存のヘッドレスモードを実行するだけです。デフォルトでは変更があれば PR を開きます(`peter-evans/create-pull-request`、diff が空なら安全な no-op); `--no-pr` はトリガーしたブランチへ直接コミットします。`--dry-run` は YAML を書き込まずに出力するだけです; 同じ `--out` パスで `jeo routine init` を再実行すると `--force` なしでは上書きを拒否します。ワークフローの最初の実際の実行前に、リポジトリシークレット `ANTHROPIC_API_KEY`(または `--api-key-env <VAR>`)を設定してください。

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
- **[0.8.28]** (2026-07-16) — Improved the welcome UI's right-side table to display dynamic sections (What's New, Flow keys, Project pulse, and Session trail) matching gajae-code (gjc) >= 0.8.0 features.
- **[0.8.27]** (2026-07-16) — Repeat-read recovery now survives both context-overflow and refusal-result elision without reopening mutating-call loops.
- **[0.8.26]** (2026-07-14) — Model catalog cleanup (drop sub-4.6 Anthropic `claude-haiku-4-5` from the exposed catalog/aliases per user direction) plus a focused gap analysis against `gajae-code`'s (gjc) 0.8.0→0.10.1 release history (~200 PRs) — most of gjc's surface (RPC/ACP/coordinator-mcp/IRC-sidebar/psmux/Windows-team) doesn't exist in jeo's smaller architecture and was ruled out with direct evidence; a few genuinely applicable gaps were found and closed.
- **[0.8.25]** (2026-07-13) — Post-audit follow-up: 0.8.24's fixture-repair subagent flagged (but, correctly, did not itself fix — out of its assigned scope) a case-sensitivity bug in the new PlanSchema maker→verifier ordering rule. Fixed.
- **[0.8.24]** (2026-07-13) — Follow-up gap analysis against the same external "self-improving agent system" framework (Fable-5-style loops), continuing 0.8.23's audit into 4 more primitives: independent-verifier ENFORCEMENT (0.8.23 had the gate logic but nothing forced a plan to actually contain one), model-tier safety-boundary fallback (a false-positive safety refusal previously backed off forever on the SAME model instead of trying a genuinely different one — the pattern already shipped for rate limits), memory confidence that was self-assigned once instead of earned via a real verification event, and Dynamic Workflows (jeo had parallel fan-out but no sequential composition or real control flow across subagent calls). Closed all 4, the last one non-trivially: an in-process `AsyncFunction` (the same pattern `browser {run}` already ships) cannot be given a real wall-clock timeout — a synchronous bug in agent-authored code blocks jeo's own event loop forever, and `Promise.race` can never preempt it (verified empirically). Fixed by running Dynamic Workflows scripts in an isolated `Worker` (a genuinely separate OS thread `worker.terminate()` can preempt unconditionally, mirroring `bashTool`'s own SIGTERM/SIGKILL escalation on a spawned process) with `task()` bridged back to the main thread over a `postMessage` RPC — config/credentials never leave the main thread, and every dispatch (however the script shapes it) stays bounded by a real concurrency semaphore, not just a per-call count cap.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
