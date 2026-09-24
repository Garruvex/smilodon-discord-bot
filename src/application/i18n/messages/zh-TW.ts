import type { MessageKey } from "./en.js";

// DRAFT Traditional Chinese (zh-TW) translations — pending review by a native
// speaker. Keys and {placeholders} must match en.ts exactly.
export const zhTW: Record<MessageKey, string> = {
  "music.autoqueue": "自動佇列",
  "music.lyrics": "歌詞",

  "panel.request.denied": "你需要音樂控制身分組才能點歌。",
  "panel.request.searching": "搜尋中…",
  "panel.request.failed": "無法完成此請求。",

  "panel.control.unsupported": "此控制項已不再支援。",
  "panel.control.guildOnly": "此控制項僅能在伺服器中使用。",
  "panel.control.obsolete": "此控制面板已過期，請使用目前的面板訊息。",
  "panel.control.denied": "你需要音樂控制身分組才能使用此控制項。",
  "panel.control.staleReset": "機器人的語音連線與播放器不同步，因此已重設此次播放。",
  "panel.control.failed": "控制項執行失敗。",

  "panel.hint.join": "請先加入語音頻道。{requesters}",
  "panel.hint.requestersOpen": "任何人都可以在這裡輸入歌名或網址來點歌。",
  "panel.hint.requestersRestricted": "擁有音樂控制身分組的成員可以在這裡輸入歌名或網址來點歌。",
  "panel.hint.legend": "-# ♾️ 自動佇列：佇列播完時自動加入相似的曲目。  •  🔁 24/7：閒置時保持連線，不會離開。",

  "panel.nowPlaying.idleTitle": "目前沒有播放歌曲",
  "panel.nowPlaying.idleDescription": "播放器已準備好接受新的點歌。",
  "panel.nowPlaying.titlePaused": "播放已暫停",
  "panel.nowPlaying.titlePlaying": "正在播放",
  "panel.nowPlaying.requestedBy": "點歌者：{user}",
  "panel.nowPlaying.requestedByAutoqueue": "點歌者：{user}（自動佇列）",
  "panel.nowPlaying.requestedByAutoqueueUnknownBot": "點歌者：自動佇列",

  "panel.lyrics.title": "🎤 歌詞",
  "panel.lyrics.idle": "目前沒有正在播放的內容。",
  "panel.lyrics.notFound": "找不到這首曲目的歌詞。",
  "panel.lyrics.searching": "正在尋找歌詞…",

  "panel.queue.title": "佇列",
  "panel.queue.empty": "佇列中沒有曲目。",
  "panel.queue.summary": "**佇列共 {count} 首**（總長 {duration}）",
  "panel.queue.more": "…還有 {count} 首，使用 `/queue show` 查看其餘曲目",
  "panel.queue.footerEmpty": "佇列已空",
  "panel.queue.footerCount": "待播 {count} 首",
  "panel.queue.footerLoop": "重複：{mode}",
  "panel.queue.autoqueueIssue": "⚠️ 自動佇列找不到可加入的曲目",
  "panel.repeat.off": "關閉",
  "panel.repeat.track": "單曲",
  "panel.repeat.queue": "整個佇列",
};
