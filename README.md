# Fuzitter 提出物 README

## 1. 提出物の概要

このフォルダには、Moodle向け学習支援デスクトップアプリ「Fuzitter」の作品一式、使用方法を説明するチュートリアルPDF、発表会プレゼンテーション動画の素材を収録しています。

## 2. 提出内容と保存場所

### 2.1 作品

実行ファイルとプログラムソースを収録しています。

| 内容 | 保存場所 | 説明 |
| --- | --- | --- |
| Windows用インストーラー | `dist/Fuzitter-Setup-0.2.0.exe` | Windows 11以降でFuzitterをインストールするための実行ファイルです。 |
| 直接起動版 | `dist/Fuzitter-win32-x64/Fuzitter.exe` | インストールせず、展開済みフォルダから直接起動する実行ファイルです。同じフォルダ内のDLLや`resources`も実行に必要です。 |
| アプリ本体のソース | `src/` | Electronのメイン処理、画面、Moodle連携、ファイル管理、タイムライン、設定保存などの実装です。 |
| 画像・アイコン | `assets/` | アプリのアイコンやチュートリアル作成用画像です。 |
| ビルド・生成処理 | `scripts/` | Windows版のビルド処理やチュートリアルPDF生成処理です。 |
| 自動テスト | `tests/` | 主要ロジックと画面構成の回帰テストです。 |
| Webサイト | `FuzitterSite/` | Fuzitter紹介・配布サイトのソースです。 |
| 依存関係・実行設定 | `package.json`、`package-lock.json` | 使用ライブラリ、実行、テスト、ビルドの設定です。 |

インストーラーを使用する場合は、`dist/Fuzitter-Setup-0.2.0.exe`を実行し、画面の案内に従ってインストールしてください。ソースから確認する場合は、Node.js環境で`npm install`後に`npm start`を実行します。

### 2.2 チュートリアル画面（PDF）

| 内容 | 保存場所 | 説明 |
| --- | --- | --- |
| Fuzitter取扱説明書 | `docs/Fuzitter_Tutorial.pdf` | 導入、初期設定、基本操作、コース連携、タイムライン、ショートカット、更新、連携解除を全8ページで説明しています。アプリ右上の「チュートリアル」ボタンからも表示できます。 |

`docs/`には、このチュートリアルのほか、仕様書、技術資料、データフロー、開発・更新手順などの関連文書を収録しています。

### 2.3 発表会プレゼンテーション動画の素材

素材は`Presentation/`に収録しています。

| ファイル | 容量（約） | 説明 |
| --- | ---: | --- |
| `Presentation/Fuzitter_out.mp4` | 450.5 MiB | 発表会用プレゼンテーションの完成動画です。 |
| `Presentation/あプでザ_1.mp4` | 11.5 MiB | プレゼンテーション編集用の動画素材・動作デモ録画（1）です。 |
| `Presentation/あプでザ_2.mp4` | 10.4 MiB | プレゼンテーション編集用の動画素材・動作デモ録画（2）です。 |
| `Presentation/あプでザ_3.mp4` | 3.4 MiB | プレゼンテーション編集用の動画素材・動作デモ録画（3）です。 |
| `Presentation/あプでザ_4.mp4` | 7.6 MiB | プレゼンテーション編集用の動画素材・動作デモ録画（4）です。 |
| `Presentation/あプでザ_5.mp4` | 0.7 MiB | プレゼンテーション編集用の動画素材・動作デモ録画（5）です。 |
| `Presentation/あプでザ_6.mp4` | 5.2 MiB | プレゼンテーション編集用の動画素材・動作デモ録画（6）です。 |

再頒布が禁止されている素材、および映っている人物から肖像利用の確認が取れていない動作デモ録画は、提出物に同梱していません。

### 2.4 FuzitterSite

`FuzitterSite/FuzitterSite/`には、Fuzitterの紹介・配布用Webサイトを収録しています。公開先は [Fuzitter公式サイト](https://negi310.github.io/Fuzzy/) です。

| 内容 | 保存場所 | 説明 |
| --- | --- | --- |
| ページ本体 | `FuzitterSite/FuzitterSite/index.html` | Fuzitterの概要、主な機能、スクリーンショット、FAQ、ダウンロード導線を構成します。 |
| デザイン | `FuzitterSite/FuzitterSite/style.css` | レスポンシブレイアウト、配色、カード、アニメーションなどの表示スタイルです。 |
| 画面動作 | `FuzitterSite/FuzitterSite/script.js` | スクロール演出、スクリーンショット表示、GitHub Releasesから最新版Setupを取得するダウンロード処理です。 |
| サイト素材 | `FuzitterSite/FuzitterSite/assets/` | ロゴ、画面画像、機能アイコン、開発者画像などです。 |
| 公開処理 | `.github/workflows/github-pages.yml` | mainブランチのサイト内容をGitHub Pagesへ公開するワークフローです。 |

サイト上のDownloadボタンは、GitHub Releasesの最新版から`Fuzitter-Setup-*.exe`を検索し、Windows用インストーラーを直接ダウンロードします。取得できない場合はGitHubの最新リリース画面へ移動します。

## 3. フォルダ構成

```text
Fuzzy/
├─ README.md                         提出物全体の説明（本ファイル）
├─ package.json                      実行・テスト・ビルド設定
├─ src/                              Fuzitterのプログラムソース
├─ assets/                           アイコン・画像素材
├─ docs/
│  ├─ Fuzitter_Tutorial.pdf          使用方法を説明するチュートリアル
│  └─ ...                            仕様書・技術資料・開発資料
├─ Presentation/
│  ├─ Fuzitter_out.mp4               発表会用完成動画
│  └─ あプでザ_1.mp4 ～ _6.mp4       動画素材・動作デモ録画
├─ dist/
│  ├─ Fuzitter-Setup-0.2.0.exe       Windows用インストーラー
│  └─ Fuzitter-win32-x64/            直接起動版と実行に必要なファイル
├─ scripts/                          ビルド・生成用スクリプト
├─ tests/                            自動テスト
└─ FuzitterSite/
   └─ FuzitterSite/
      ├─ index.html                  紹介・配布サイトのページ本体
      ├─ style.css                   サイトのデザイン
      ├─ script.js                   表示演出・最新版ダウンロード処理
      └─ assets/                     ロゴ・画面画像・機能アイコン
```

## 4. 提出時の注意

- `dist/Fuzitter-win32-x64/`は、`Fuzitter.exe`だけを取り出さず、フォルダ一式で扱ってください。
- `Presentation/`には、提出・再生・再頒布が可能な素材だけを収録してください。
- `Presentation/`の動画と`dist/Fuzitter-Setup-0.2.0.exe`は大容量のため、提出用フォルダまたはアーカイブを作成した後、実ファイルが含まれていることを確認してください。
- 実行環境はWindows 11以降を対象としています。
