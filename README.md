# SCANDECK

ブラウザだけで完結する書類スキャナー。カメラで撮影 → 斜め補正(四隅ドラッグ) → 影・ムラ除去 → OCR → 検索可能PDF、をすべてクライアントサイドで行います。サーバーには何も送信されません。

## 使い方

1. カメラのシャッターボタンで書類を撮影
2. 四隅のハンドルをドラッグして書類の枠に合わせる(自動検出ボタンで再検出も可能)
3. 「この範囲で確定」で透視補正を適用 → フィルムストリップにページが追加される
4. 複数ページある場合は 1〜3 を繰り返す
5. 右上の ✓ ボタンで「影除去 → コントラスト調整 → OCR → PDF組版」を実行
6. 完成したPDFをダウンロード

## 技術構成(すべてブラウザ内で完結)

| 処理 | 使用技術 |
|---|---|
| 斜め補正 | OpenCV.js の `getPerspectiveTransform` / `warpPerspective`(四隅ドラッグ+自動輪郭検出) |
| 指の写り込み除去 | 書類の輪郭内側だけを切り出すことで対応(完全な自動inpaintingは未対応) |
| 影・ムラ除去 | チャンネルごとに背景を推定(dilate+medianBlur)し差分を正規化する古典的手法 |
| コントラスト強調 | CLAHE(LAB色空間のL成分に適用) |
| OCR | [Tesseract.js](https://github.com/naptha/tesseract.js)(`jpn+eng`) |
| PDF生成 | [jsPDF](https://github.com/parallax/jsPDF)(画像+透明テキストレイヤーで検索可能PDFに) |

## GitHub Pagesへのデプロイ

```bash
git init
git add .
git commit -m "Initial commit: SCANDECK"
git branch -M main
git remote add origin https://github.com/<your-account>/<your-repo>.git
git push -u origin main
```

その後、リポジトリの **Settings → Pages → Source** で `main` ブランチ / `/ (root)` を指定すれば、`https://<your-account>.github.io/<your-repo>/` で公開されます。

## 注意点・既知の制限

- **カメラ利用にはHTTPS(またはlocalhost)が必須**です。GitHub Pagesは自動的にHTTPSになるので問題ありません。
- 指の写り込み除去は「輪郭内クロップ」による間接的な対応です。書類の内側にまで指がかかっている場合は完全には消せません。
- OCRの精度は元画像の解像度・照明条件に左右されます。Tesseract.jsの初回実行時は言語データ(数MB)をCDNからダウンロードするため、オフライン環境では動作しません(完全オフライン化したい場合は `jpn.traineddata` / `eng.traineddata` をリポジトリに同梱し、`Tesseract.createWorker` の `langPath` オプションで指定してください)。
- PDFの透明テキストレイヤーは単語単位のバウンディングボックスに基づく簡易実装のため、選択範囲の精度は市販スキャンアプリほど厳密ではありません。
- `opencv.js` は `docs.opencv.org` から読み込んでいます。本番運用で安定性を重視する場合は、`opencv.js` を自分のリポジトリ内にホストすることを推奨します。

## ライセンス

- OpenCV.js: Apache 2.0
- Tesseract.js: Apache 2.0
- jsPDF: MIT

利用しているCDN上のライブラリは、それぞれの配布元のライセンスに従います。
