import type { SettingsTextCatalog } from "../catalog.js";

export const zhTWCommunity: SettingsTextCatalog = {
  "community": { title: "社群", description: "獨立的社群功能" },

  "community.language": { label: "語言", description: "設定此伺服器已支援翻譯的機器人訊息所使用的語言" },
  "community.language.language": { label: "語言", description: "要使用的語言" },

  "community.timezone": { label: "時區", description: "設定生日及其他伺服器當地日期使用的 IANA 時區" },
  "community.timezone.zone": {
    label: "時區",
    description: "IANA 時區名稱，例如 \"America/New_York\" 或 \"Asia/Taipei\"",
    messages: { unknown: "「{zone}」不是可辨識的 IANA 時區名稱（例如 \"America/New_York\"）" },
  },

  "community.birthdays": {
    label: "生日",
    description: "設定自動生日公告",
    messages: { "needs-channel": "開啟前請先設定生日公告頻道" },
  },
  "community.birthdays.enabled": { label: "生日公告", description: "開啟或關閉生日公告" },
  "community.birthdays.channel": { label: "公告頻道", description: "發布生日公告的文字頻道" },

  "community.reminders": { label: "提醒", description: "設定成員是否能設定個人提醒" },
  "community.reminders.enabled": { label: "提醒", description: "開啟或關閉 /remind 指令" },

  "community.welcome": { label: "加入與離開訊息", description: "設定成員加入／離開公告的頻道" },
  "community.welcome.join-channel": { label: "歡迎頻道", description: "發布新成員歡迎卡片的位置" },
  "community.welcome.leave-channel": { label: "離開頻道", description: "發布成員離開訊息的位置" },

  "community.link-fix": {
    label: "連結修正",
    description: "設定支援平台的連結自動改寫",
    messages: { "needs-channel": "開啟前請先新增至少一個監看頻道" },
  },
  "community.link-fix.enabled": { label: "連結修正", description: "開啟或關閉連結自動改寫" },
  "community.link-fix.channels": { label: "監看頻道", description: "監看可改寫連結的文字頻道" },
  "community.link-fix.twitter": { label: "Twitter/X", description: "開啟或關閉 Twitter/X 連結修正" },
  "community.link-fix.threads": { label: "Threads", description: "開啟或關閉 Threads 連結修正" },
  "community.link-fix.tiktok": { label: "TikTok", description: "開啟或關閉 TikTok 連結修正" },
  "community.link-fix.instagram": { label: "Instagram", description: "開啟或關閉 Instagram 連結修正" },
  "community.link-fix.reddit": { label: "Reddit", description: "開啟或關閉 Reddit 連結修正" },
  "community.link-fix.bilibili": { label: "Bilibili", description: "開啟或關閉 Bilibili 連結修正" },

  "community.nsfw": { label: "NSFW 指令", description: "開啟或關閉此伺服器的 NSFW 圖片指令" },
  "community.nsfw.enabled": { label: "NSFW 指令", description: "允許 NSFW 圖片指令（仍須在年齡限制頻道中使用）" },

  "community.member-data": { label: "成員資料", description: "控制成員離開後其資料要保留還是刪除" },
  "community.member-data.retain": {
    label: "保留離開成員的資料",
    description: "true：保留資料，供成員回來時使用；false：成員離開時刪除資料",
  },
};
