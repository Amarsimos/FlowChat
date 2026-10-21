# FlowChat Overlay (Desktop Client)

FlowChat の表示ページを、デスクトップ全面に透明・最前面・クリック透過のオーバーレイとして表示する Electron アプリです。

## 機能

- 初回起動時に表示する URL と表示先モニターを選択（次回以降は前回の設定で自動起動）
- 枠なし・透明背景・常に最前面（`screen-saver` レベル、1 秒ごとに再適用）
- マウスクリックは背面のウィンドウへ透過
- ページ読み込み時に CSS を注入し、背景を透明化
- タスクトレイから 表示/非表示・再読み込み・設定変更・終了
- 通信エラーやクラッシュ時は 5 秒後に自動再読み込み
- モニターの取り外し・解像度変更に追従
- 多重起動の防止
- `Ctrl + Alt + Q` で終了
- 自動アップデート（GitHub Releases）

## 使い方（開発）

```bash
cd overlay
npm install
npm start
```

> VS Code のターミナルでは `ELECTRON_RUN_AS_NODE=1` が設定されていて起動に失敗することがあります。その場合は環境変数を外して実行してください。

## ビルド（Windows）

```bash
npm run dist
```

`dist/` に以下の 2 つが出力されます。

- `FlowChatSystem Setup.exe`：インストーラー（ユーザー領域へのワンクリックインストール、管理者権限不要、自動アップデート対応）
- `FlowChatSystem.zip`：インストール不要版（展開して `FlowChatSystem.exe` を実行、自動アップデートなし）

## リリース

1. `package.json` の `version` を上げる
2. `FlowChatSystem-v<version>` のタグを push する（例: `git tag FlowChatSystem-v1.0.1 && git push origin FlowChatSystem-v1.0.1`）
3. GitHub Actions がインストーラーをビルドし GitHub Releases に公開
4. インストール済みのクライアントは次回起動時に自動で更新

## 補足

- コード署名なしのため、初回実行時に SmartScreen の警告が出ます（「詳細情報」→「実行」）。
- タスクマネージャーなど UIAccess 権限を持つシステムウィンドウより上には表示できません。
- 設定は `%APPDATA%\FlowChatSystem\settings.json` に保存されます。
