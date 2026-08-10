# stock-trader-portfolio

自動売買 bot（paper trading）のポートフォリオを公開するための静的サイトです。

公開ページ: https://10matcho27.github.io/stock-trader-portfolio/

## これは何か

- 別リポジトリの生成器が書き出した `data/portfolio.json` と、それを描画するページだけを置いています。
- **paper trading（仮想売買）の記録であり、実口座の取引ではありません。**
- **投資助言ではありません。** 特定の銘柄の売買を推奨するものではありません。

## 更新

- 平日 11:35 / 15:05 JST に自動更新されます。
- 表示中の `generated_at` が最終更新時刻です。ここが古い場合、更新が止まっています。

## 構成

```
.nojekyll            Jekyll 処理を無効化
index.html           ページ本体
data/portfolio.json  表示するデータ（自動生成・上書き）
```

このリポジトリにアプリケーションコードは含まれません。
