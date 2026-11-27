# session-dashboard

並列で動かしている Claude Code セッションの状態を、ブラウザの 1 画面で一覧するダッシュボードです。

- **状態の札**: 返事待ち（実行許可・選択肢の質問、または Claude の最後の発言が質問・依頼で終わっている）・指示待ち（作業を終えて何も聞かれていない）・作業中・応答なし（作業中なのに 3 分以上動きがない）・終了
- **1 行要約**: 自分の発言の最初の 1 件と直近 11 件を Haiku（`claude -p --model haiku`）で 1 文に要約
- **通知音**: 返事待ちになったら高い 2 音、指示待ちになったら低い 1 音を 1 回鳴らす。返事待ちが 30 分を超えると経過時間が赤くなる。返事待ちのカードには何を聞かれているか（最後の発言の末尾）を表示
- **閉じてよい**: 指示待ちで、作業ディレクトリに未コミットの変更がない
- **チケット**: 発言に Notion の URL があれば「チケット名（URL）」の形で表示（最大 3 件、最初に出てきた順）。チケット名の取得には Notion のトークンが必要（下の「Notion のトークン」）。無ければ URL だけ表示
- **PR リンク**: 作業ブランチに PR があれば、番号・状態（Open / Draft / Merged / Closed）・タイトル付きのリンクを表示（`gh` CLI でログインしている必要あり。PR が無いブランチは 30 秒ごとに見直す）
- **補足表示**: ブランチ、未コミットのファイル数、直近に使ったスキル 2 つ、VSCode で開くリンク
- **作業メモ・TODO**:
  - **セッションごと**: カード下の「📝 メモ・TODO」に、そのセッションの TODO とメモを書ける
  - **全体（右側のパネル）**: 「やること」（全体の TODO と、各セッションの未完了 TODO を作業名付きで一覧）と「やったこと」（その日に完了にした TODO）。◀ ▶ で過去の日の「やったこと」を見られる
  - メモは打ち終わって 0.8 秒後（またはフォーカスが外れたとき）に自動で保存。TODO は文字をダブルクリックで編集、× で削除
  - 保存先は `~/.claude/session-dashboard/notes.json`。開いている他のタブにもすぐ反映される

## 仕組み

```
Claude Code ──フック──▶ bin/record.mjs ──▶ ~/.claude/session-dashboard/state/<session_id>.json
                                                        │
                    server/server.mjs ◀─────────────────┘ ＋ transcript (~/.claude/projects/**.jsonl)
                          │ SSE
                          ▼
                    ブラウザ（http://127.0.0.1:7878）
```

| フック | 状態 |
| --- | --- |
| `SessionStart` | 返事待ち |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | 作業中（`Skill` ならスキル名を記録、`AskUserQuestion` なら返事待ち） |
| `Notification`（`permission_prompt`） | 返事待ち（実行許可） |
| `Stop` | 返事待ち |
| `SessionEnd` | 終了 |

外部パッケージは使わず、Node（v22 以降）の標準モジュールだけで動きます。サーバーは `127.0.0.1` だけで待ち受けます。

## 使い方

1. プラグインを入れる（フックが有効になります。入れた後に起動したセッションから記録されます）

   ```
   /plugin install session-dashboard --marketplace howehoe/claude-mods
   ```

2. サーバーを起動する

   ```sh
   node ~/git/claude-mods/plugins/session-dashboard/server/server.mjs
   ```

3. http://127.0.0.1:7878 を開き、右上のボタンを一度押して通知音を有効にする（ブラウザの自動再生制限のため、開き直すたびに必要）

Chrome の「アプリとしてインストール」（アドレスバー右のアイコン）で単独ウィンドウにすると、別モニターに常時表示しやすくなります。

### Notion のトークン

チケット名を出すには、Notion のインテグレーションのトークン（`ntn_...`）を次のどちらかで渡します。チケットのページがそのインテグレーションに共有されている必要があります。

- 環境変数 `CC_DASHBOARD_NOTION_TOKEN`（または `NOTION_TOKEN`）
- ファイル `~/.claude/session-dashboard/notion-token`（`chmod 600` 推奨）

API は Node の fetch ではなく `curl` で呼びます（社内プロキシの証明書を Node が信頼しない環境でも動くように）。取得したチケット名は `~/.claude/session-dashboard/tickets.json` にキャッシュし、取れなかったものは 10 分後に取り直します。

### 環境変数

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `CC_DASHBOARD_PORT` | `7878` | ポート |
| `CC_DASHBOARD_DIR` | `~/.claude/session-dashboard` | 状態ファイル・要約キャッシュの置き場（フック側と合わせる） |
| `CC_DASHBOARD_NO_SUMMARY` | – | `1` で Haiku 要約を行わない |

## 制限

- ダッシュボードからセッションへ許可・指示はできません（書き込めるのはメモ・TODO だけ）
- メモ・TODO の書き込み API（`POST /api/notes`）は、Host / Origin がこのサーバー自身で、かつ JSON で送られたものだけ受け付けます（他のサイトから書き換えられないように）
- Esc で中断した場合はフックが飛ばないため、3 分後に「応答なし」になります
- 返事待ち / 指示待ちは Claude の最後の発言の末尾 3 行の言い回し（`？` / `〜ますか` / `〜ください` など）で判定するので、外れることがあります
- 要約は 1 セッションにつき最大で 1 分に 1 回、発言数が増えたときだけ作り直します（`claude -p` を使うので利用枠を少し消費します）
- transcript は既定で 30 日で消えます（`settings.json` の `cleanupPeriodDays`）

## テスト

```sh
node --test plugins/session-dashboard/test/*.test.mjs
```
