import type { TranslationCatalog } from "./en.js";

// Traditional Chinese (zh-TW). DRAFT — pending review by a native speaker.
// Any key from en.ts left out here shows in English; `{placeholders}` must
// match the English message's.
export const zhTW = {
  "music.label.autoqueue": "自動佇列",
  "music.label.lyrics": "歌詞",
  "music.label.repeat.off": "關閉",
  "music.label.repeat.track": "單曲",
  "music.label.repeat.queue": "整個佇列",

  "music.panel.request.denied": "你需要音樂控制身分組才能點歌。",
  "music.panel.request.searching": "搜尋中…",
  "music.panel.request.failed": "無法完成此請求。",

  "music.panel.control.unsupported": "此控制項已不再支援。",
  "music.panel.control.guildOnly": "此控制項僅能在伺服器中使用。",
  "music.panel.control.obsolete": "此控制面板已過期，請使用目前的面板訊息。",
  "music.panel.control.denied": "你需要音樂控制身分組才能使用此控制項。",
  "music.panel.control.staleReset": "機器人的語音連線與播放器不同步，因此已重設此次播放。",
  "music.panel.control.failed": "控制項執行失敗。",

  "music.panel.hint.join": "請先加入語音頻道。{requesters}",
  "music.panel.hint.requestersOpen": "任何人都可以在這裡輸入歌名或網址來點歌。",
  "music.panel.hint.requestersRestricted": "擁有音樂控制身分組的成員可以在這裡輸入歌名或網址來點歌。",
  "music.panel.hint.legend": "-# ♾️ 自動佇列：佇列播完時自動加入相似的曲目。  •  🔁 24/7：閒置時保持連線，不會離開。",

  "music.panel.nowPlaying.idleTitle": "目前沒有播放歌曲",
  "music.panel.nowPlaying.idleDescription": "播放器已準備好接受新的點歌。",
  "music.panel.nowPlaying.titlePaused": "播放已暫停",
  "music.panel.nowPlaying.titlePlaying": "正在播放",
  "music.panel.nowPlaying.requestedBy": "點歌者：{user}",
  "music.panel.nowPlaying.requestedByAutoqueue": "點歌者：{user}（自動佇列）",
  "music.panel.nowPlaying.requestedByAutoqueueUnknownBot": "點歌者：自動佇列",

  "music.panel.lyrics.title": "🎤 歌詞",
  "music.panel.lyrics.idle": "目前沒有正在播放的內容。",
  "music.panel.lyrics.notFound": "找不到這首曲目的歌詞。",
  "music.panel.lyrics.searching": "正在尋找歌詞…",

  "music.panel.queue.title": "佇列",
  "music.panel.queue.empty": "佇列中沒有曲目。",
  "music.panel.queue.summary": "**佇列共 {count} 首**（總長 {duration}）",
  "music.panel.queue.more": "…還有 {count} 首，使用 `/queue show` 查看其餘曲目",
  "music.panel.queue.footerEmpty": "佇列已空",
  "music.panel.queue.footerCount": "待播 {count} 首",
  "music.panel.queue.footerLoop": "重複：{mode}",
  "music.panel.queue.autoqueueIssue": "⚠️ 自動佇列找不到可加入的曲目",
} as const satisfies TranslationCatalog;
