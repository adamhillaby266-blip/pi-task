# Pi Task

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Русский](./README.ru.md)

> Pi を利用する開発者向けのローカルなソースコード版タスク・ワークスペースです。Pi の会話を中心に、永続的な Task、Run、成果物、Review、人による承認を追加します。

Pi Task はエンドユーザー向けインストーラーではありません。Gate D の日常タスクフローと Gate E の macOS ローカル利用経路には受入記録がありますが、署名済みアプリ、自動更新、ホスティング、外部配布は対象外です。

## 機能

- 保存済み Pi 会話を、人が確認する契約付き Task に整理します。
- Task/Run のライフサイクルを Agent のストリーミング状態から分離し、人だけが Review を承認して Task を完了できます。
- 中断、ブロック、キャンセル、同一 Session での再開、成果物、Review の証跡を扱えます。
- ローカル Pi セッションの閲覧、リアルタイムチャット、モデルと Skill の操作、ファイルプレビュー、Git worktree 切替を提供します。

## 利用境界

Pi Task は開発者のローカル利用専用です。

- ソースランチャーは loopback ホスト（`127.0.0.1` または `localhost`）のみを受け入れ、文書化された開発・macOS 起動経路は `127.0.0.1:30142` を使用します。
- LAN 公開、リバースプロキシ、インターネット公開、Docker、npm 公開、デスクトップ配布、GitHub Release はサポートしません。
- Pi Web と Pi Task で同じ実行中 Pi Session を同時に操作しないでください。
- プロンプトを送信すると、ローカル Pi に設定されたモデル Provider にプロンプト、関連するツール結果、選択した作業ディレクトリのファイルが渡る場合があります。Provider のデータポリシーを確認してください。

## ソースから起動

**必要条件：** Node.js 22.19.0 以降。

```bash
git clone <repository-url> pi-task
cd pi-task
npm ci --include=dev --ignore-scripts
npm run dev
```

<http://127.0.0.1:30142> を開きます。このリポジトリはエンドユーザー向け npm パッケージではありません。上流由来の `npx`、グローバルインストール、`pi-web` コマンドは使用しないでください。

隔離開発、検証、macOS ビルドの境界は [Developing Pi Task from source](./docs/development.md) を参照してください。

## ローカルデータと安全性

- Pi セッション、モデル設定、認証は既定で `~/.pi/agent` にあります。Pi Task はこれを読み取り、会話管理やモデル/認証の操作に応じてローカルデータを書き込むことがあります。
- Task データベースは既定で `~/.pi-task/pi-task.sqlite` にあります。手動バックアップ前には Pi Task を終了してください。
- テストでは `HOME`、`TMPDIR`、`PI_CODING_AGENT_DIR`、`PI_TASK_DATA_DIR` を無視対象の `.runtime/` 以下に設定してください。実際の認証情報、未公開資料、会社データを fixture に入れないでください。
- `.gitignore` は安全網であり、秘密管理の仕組みではありません。コミット前に `git status` を確認し、Pi データ、SQLite、JSONL、環境ファイル、ログ、秘密鍵を追加しないでください。

## 検証

依存関係のインストール後、リポジトリ直下で実行します。

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

通常の開発中に `next build` や `npm run build` を実行しないでください。`.next/` が書き換えられ、開発サーバーに影響する可能性があります。

## 関連ドキュメント

- [Developer source workflow](./docs/development.md)
- [Gate D architecture](./docs/architecture/gate-d.md)
- [Gate E — macOS local delivery](./docs/architecture/gate-e-macos-local.md)
- [macOS Dock/PWA local use](./docs/macos-dock-pwa.md)
- [GitHub source-publication checklist](./docs/release.md)

## ライセンスと来歴

Pi Task は [Pi Web](https://github.com/agegr/pi-web) v0.8.6 を MIT License の下で基盤として利用しています。詳細は [UPSTREAM.md](./UPSTREAM.md) と [LICENSE](./LICENSE) を参照してください。最初の公開ソースでは現在の MIT と上流の帰属を維持し、Issues は有効、Discussions は無効、外部 PR は Issue での事前調整後に受け付け、安全な報告には GitHub の非公開脆弱性報告を使用します。詳細は [the source-publication checklist](./docs/release.md)、[CONTRIBUTING.md](./CONTRIBUTING.md)、[SECURITY.md](./SECURITY.md) を参照してください。
