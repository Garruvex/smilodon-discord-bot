import type { TranslationCatalog } from "./en.js";

// Japanese (ja). DRAFT — pending review by a native speaker. Any key from
// en.ts left out here shows in English; `{placeholders}` must match the
// English message's.
export const ja = {
  "music.label.autoqueue": "オートキュー",
  "music.label.lyrics": "歌詞",
  "music.label.repeat.off": "オフ",
  "music.label.repeat.track": "1曲",
  "music.label.repeat.queue": "キュー全体",

  "music.panel.request.denied": "リクエストするにはミュージックコントローラーのロールが必要です。",
  "music.panel.request.searching": "検索中…",
  "music.panel.request.failed": "リクエストを完了できませんでした。",

  "music.panel.control.unsupported": "このコントロールはサポートされなくなりました。",
  "music.panel.control.guildOnly": "このコントロールはサーバー内でのみ使用できます。",
  "music.panel.control.obsolete": "このコントロールパネルは古くなっています。現在のパネルメッセージを使用してください。",
  "music.panel.control.denied": "このコントロールを使うにはミュージックコントローラーのロールが必要です。",
  "music.panel.control.staleReset": "ボットのボイス接続がプレイヤーと同期していなかったため、セッションをリセットしました。",
  "music.panel.control.failed": "コントロールの実行に失敗しました。",

  "music.panel.hint.join": "ボイスチャンネルに参加してください。{requesters}",
  "music.panel.hint.requestersOpen": "ここに曲名またはURLを入力すれば、誰でも曲をキューに追加できます。",
  "music.panel.hint.requestersRestricted": "ミュージックコントローラーのロールを持つメンバーは、ここに曲名またはURLを入力して曲をキューに追加できます。",
  "music.panel.hint.legend": "-# ♾️ オートキュー：キューが終わると似た曲を自動で追加します。  •  🔁 24/7：待機中も切断せず接続を維持します。",

  "music.panel.nowPlaying.idleTitle": "再生中の曲はありません",
  "music.panel.nowPlaying.idleDescription": "プレイヤーは新しいリクエストを受け付けられます。",
  "music.panel.nowPlaying.titlePaused": "一時停止中",
  "music.panel.nowPlaying.titlePlaying": "再生中",
  "music.panel.nowPlaying.requestedBy": "リクエスト：{user}",
  "music.panel.nowPlaying.requestedByAutoqueue": "リクエスト：{user}（オートキュー）",
  "music.panel.nowPlaying.requestedByAutoqueueUnknownBot": "リクエスト：オートキュー",

  "music.panel.lyrics.title": "🎤 歌詞",
  "music.panel.lyrics.idle": "現在再生中の曲はありません。",
  "music.panel.lyrics.notFound": "この曲の歌詞は見つかりませんでした。",
  "music.panel.lyrics.searching": "歌詞を探しています…",

  "music.panel.queue.title": "キュー",
  "music.panel.queue.empty": "キューに曲はありません。",
  "music.panel.queue.summary": "**キュー内 {count} 曲**（合計 {duration}）",
  "music.panel.queue.more": "…ほか {count} 曲。残りは `/queue show` で確認できます",
  "music.panel.queue.footerEmpty": "キューは空です",
  "music.panel.queue.footerCount": "待機中 {count} 曲",
  "music.panel.queue.footerLoop": "リピート：{mode}",
  "music.panel.queue.autoqueueIssue": "⚠️ オートキューが追加する曲を見つけられませんでした",
} as const satisfies TranslationCatalog;
