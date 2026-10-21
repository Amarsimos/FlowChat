# FlowChat Overlay (Desktop Client)

FlowChat の表示ページを、デスクトップ全面に透明・最前面・クリック透過のオーバーレイとして表示する Electron アプリです。

## 機能

- 起動時に表示する URL と表示先モニターを選択
- 枠なし・透明背景・常に最前面（`screen-saver` レベル、1 秒ごとに再適用）
- マウスクリックは背面のウィンドウへ透過
- ページ読み込み時に CSS を注入し、背景を透明化
- 多重起動の防止
- `Ctrl + Alt + Q` で終了

## 使い方

```bash
cd overlay
npm install
npm start
```

## ビルド（Windows）

```bash
npm run dist
```

`dist/` に zip 形式のポータブル版が出力されます。

## 補足

- 他の最前面ウィンドウやタスクバーより上に表示するため、ビルド版は管理者権限で起動します（`requestedExecutionLevel: requireAdministrator`）。
- タスクマネージャーなど UIAccess 権限を持つシステムウィンドウより上には表示できません。
