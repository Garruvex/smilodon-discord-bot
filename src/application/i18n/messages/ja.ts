import type { MessageKey } from "./en.js";

// DRAFT Japanese (ja) translations — pending review by a native speaker.
// Keys and {placeholders} must match en.ts exactly.
export const ja: Record<MessageKey, string> = {
  "music.autoqueue": "オートキュー",
  "music.lyrics": "歌詞",

  "panel.request.denied": "リクエストするにはミュージックコントローラーのロールが必要です。",
  "panel.request.searching": "検索中…",
  "panel.request.failed": "リクエストを完了できませんでした。",

  "panel.control.unsupported": "このコントロールはサポートされなくなりました。",
  "panel.control.guildOnly": "このコントロールはサーバー内でのみ使用できます。",
  "panel.control.obsolete": "このコントロールパネルは古くなっています。現在のパネルメッセージを使用してください。",
  "panel.control.denied": "このコントロールを使うにはミュージックコントローラーのロールが必要です。",
  "panel.control.staleReset": "ボットのボイス接続がプレイヤーと同期していなかったため、セッションをリセットしました。",
  "panel.control.failed": "コントロールの実行に失敗しました。",

  "panel.hint.join": "ボイスチャンネルに参加してください。{requesters}",
  "panel.hint.requestersOpen": "ここに曲名またはURLを入力すれば、誰でも曲をキューに追加できます。",
  "panel.hint.requestersRestricted": "ミュージックコントローラーのロールを持つメンバーは、ここに曲名またはURLを入力して曲をキューに追加できます。",
  "panel.hint.legend": "-# ♾️ オートキュー：キューが終わると似た曲を自動で追加します。  •  🔁 24/7：待機中も切断せず接続を維持します。",

  "panel.nowPlaying.idleTitle": "再生中の曲はありません",
  "panel.nowPlaying.idleDescription": "プレイヤーは新しいリクエストを受け付けられます。",
  "panel.nowPlaying.titlePaused": "一時停止中",
  "panel.nowPlaying.titlePlaying": "再生中",
  "panel.nowPlaying.requestedBy": "リクエスト：{user}",
  "panel.nowPlaying.requestedByAutoqueue": "リクエスト：{user}（オートキュー）",
  "panel.nowPlaying.requestedByAutoqueueUnknownBot": "リクエスト：オートキュー",

  "panel.lyrics.title": "🎤 歌詞",
  "panel.lyrics.idle": "現在再生中の曲はありません。",
  "panel.lyrics.notFound": "この曲の歌詞は見つかりませんでした。",
  "panel.lyrics.searching": "歌詞を探しています…",

  "panel.queue.title": "キュー",
  "panel.queue.empty": "キューに曲はありません。",
  "panel.queue.summary": "**キュー内 {count} 曲**（合計 {duration}）",
  "panel.queue.more": "…ほか {count} 曲。残りは `/queue show` で確認できます",
  "panel.queue.footerEmpty": "キューは空です",
  "panel.queue.footerCount": "待機中 {count} 曲",
  "panel.queue.footerLoop": "リピート：{mode}",
  "panel.queue.autoqueueIssue": "⚠️ オートキューが追加する曲を見つけられませんでした",
  "panel.repeat.off": "オフ",
  "panel.repeat.track": "1曲",
  "panel.repeat.queue": "キュー全体",
};
