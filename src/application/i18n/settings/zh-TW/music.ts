import type { SettingsTextCatalog } from "../catalog.js";

export const zhTWMusic: SettingsTextCatalog = {
  "music": { title: "音樂", description: "音樂面板與播放行為" },

  "music.panel": { label: "音樂面板", description: "更新音樂面板", messages: { preview: "預覽：" } },
  "music.panel.channel": { label: "面板頻道", description: "音樂控制頻道" },
  "music.panel.progress-style": {
    label: "進度條",
    description: "進度條外觀",
    choices: { standard: "標準", yohta: "Yohta", custom: "自訂", none: "只顯示時間" },
    messages: {
      "yohta-missing": "這個機器人應用程式尚未設定 Yohta 樣式。缺少：{missing}。",
      "custom-missing": "請先用 /settings-music progress-emojis 設定自訂表情符號，再選擇自訂",
    },
  },
  "music.panel.progress-length": { label: "進度條長度", description: "進度條長度" },

  "music.idle-image": { label: "待機圖片", description: "沒有播放時音樂面板顯示的圖片" },
  "music.idle-image.file": { label: "圖片檔案", description: "上傳長期保存的 PNG、JPEG、WebP 或 GIF 待機圖片" },
  "music.idle-image.url": {
    label: "圖片網址",
    description: "固定的 HTTPS 待機圖片網址",
    messages: { "not-https": "待機圖片網址必須以 https:// 開頭" },
  },

  "music.default-idle-image": {
    label: "使用預設圖片",
    description: "使用內建的 Smilodon 待機圖片",
    messages: { done: "待機圖片已改回內建的預設圖片" },
  },

  "music.progress-emojis": {
    label: "自訂進度條表情符號",
    description: "設定自訂進度條的表情符號並切換為自訂",
    messages: { done: "已儲存自訂進度條表情符號，進度條現在會使用它們", "no-guild": "這只能在伺服器中使用" },
  },
  "music.progress-emojis.completed": {
    label: "已播放部分",
    description: "自訂已完成部分的表情符號；貼上表情符號或輸入其伺服器名稱",
  },
  "music.progress-emojis.remaining": {
    label: "未播放部分",
    description: "自訂剩餘部分的表情符號；貼上表情符號或輸入其伺服器名稱",
  },
  "music.progress-emojis.playing": { label: "目前位置（播放中）", description: "播放中目前位置的自訂表情符號" },
  "music.progress-emojis.paused": { label: "目前位置（暫停）", description: "暫停時目前位置的自訂表情符號" },
  "music.progress-emojis.ending": { label: "結尾", description: "選填的結尾表情符號，或輸入 'none' 移除" },

  "music.volume": { label: "音量", description: "更新音量限制" },
  "music.volume.default": { label: "預設音量", description: "預設音量" },
  "music.volume.maximum": { label: "最大音量", description: "最大音量" },
  "music.volume.button-step": { label: "音量按鈕幅度", description: "面板按鈕每次調整的幅度" },

  "music.lifecycle": { label: "離開與暫停", description: "設定待播歌曲播完或語音頻道無人時的行為" },
  "music.lifecycle.empty-queue-action": {
    label: "待播歌曲播完時",
    description: "待播歌曲播完時的動作",
    choices: { disconnect: "離開語音頻道", stay_connected: "留在語音頻道" },
  },
  "music.lifecycle.queue-delay-seconds": { label: "播完後等待（秒）", description: "待播清單清空後，執行動作前的等待時間" },
  "music.lifecycle.empty-channel-action": {
    label: "所有人離開時",
    description: "所有人離開時的動作",
    choices: { continue: "繼續播放", pause: "暫停", disconnect: "離開語音頻道" },
  },
  "music.lifecycle.channel-grace-seconds": { label: "無人時寬限（秒）", description: "執行動作前的寬限時間" },
  "music.lifecycle.resume-when-occupied": { label: "有人回來時恢復播放", description: "自動暫停後，有人回來時是否恢復播放" },

  "music.dj-mode": { label: "DJ 模式", description: "讓音樂控制身分組能在任何地方控制播放" },
  "music.dj-mode.enabled": { label: "DJ 模式", description: "是否開啟 DJ 模式" },

  "music.open-queue-requests": { label: "開放點歌", description: "讓任何人不必加入機器人所在的語音頻道也能點歌" },
  "music.open-queue-requests.enabled": { label: "開放點歌", description: "是否開啟開放點歌" },

  "music.autoqueue-vote": { label: "下一首投票", description: "讓聽眾投票決定自動續播的下一首歌" },
  "music.autoqueue-vote.enabled": { label: "下一首投票", description: "是否讓聽眾投票；關閉時由自動續播自行選歌" },
  "music.autoqueue-vote.bar-style": {
    label: "投票長條樣式",
    description: "投票長條的外觀",
    choices: { squares: "彩色方塊", thin: "細長條（與進度條一致）" },
  },
  "music.autoqueue-vote.options": { label: "候選歌曲數", description: "可供選擇的歌曲數量" },
};
