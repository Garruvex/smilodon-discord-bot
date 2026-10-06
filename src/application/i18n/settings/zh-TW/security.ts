import type { SettingsTextCatalog } from "../catalog.js";

export const zhTWSecurity: SettingsTextCatalog = {
  "security": { title: "安全", description: "自動攔截被盜帳號與垃圾訊息機器人" },

  "security.trap": {
    label: "陷阱頻道",
    description: "不該有人發言的頻道，在此發言的帳號會被自動處理",
    messages: { "needs-channel": "開啟前請先設定頻道（或使用 create-channel）" },
  },
  "security.trap.enabled": { label: "陷阱頻道", description: "開啟或關閉陷阱頻道" },
  "security.trap.channel": { label: "頻道", description: "要監看的頻道，用 create-channel 或 use-channel 還會一併發出說明" },
  "security.trap.action": {
    label: "處理方式",
    description: "在此發言的帳號會如何處理",
    choices: { timeout: "禁言", kick: "踢出", ban: "封鎖" },
  },
  "security.trap.delete-history": {
    label: "刪除其近期訊息",
    description: "要往回刪除對方多久以內的其他訊息，關閉則只刪除頻道內那一則",
    choices: { "off": "關閉", "10m": "最近 10 分鐘", "30m": "最近 30 分鐘", "1h": "最近 1 小時" },
  },
  "security.trap.timeout-duration": {
    label: "禁言時間",
    description: "處理方式為禁言時的禁言長度",
    choices: { "1h": "1 小時", "1d": "1 天", "7d": "7 天", "28d": "28 天" },
  },

  "security.create-channel": {
    label: "建立陷阱頻道",
    description: "建立一個名稱普通的頻道，並以所有語言發出說明",
    messages: {
      "no-guild": "伺服器尚未載入，請稍後再試",
      "missing-permission": "我需要「管理頻道」權限才能建立頻道",
      "failed": "無法建立頻道，請檢查我的權限後再試",
      "done": "已建立 {channel} 並發出說明，準備好後請開啟陷阱頻道",
    },
  },
  "security.use-channel": {
    label: "使用現有頻道",
    description: "使用已有的頻道，並以所有語言發出說明",
    messages: {
      "missing": "請選擇一個頻道",
      "not-text": "請選擇一般文字頻道",
      "no-access": "我需要能在 {channel} 檢視、發言並管理訊息",
      "failed": "無法在 {channel} 發出說明",
      "done": "已改用 {channel} 並發出說明，準備好後請開啟陷阱頻道",
    },
  },
  "security.use-channel.channel": { label: "頻道", description: "要當作陷阱的文字頻道" },

  "security.exempt": {
    label: "豁免身分組",
    description: "不會被處理的身分組，擁有者、機器人管理員與管理人員一律豁免",
  },
  "security.exempt.roles": { label: "豁免身分組", description: "要放過的身分組" },

  "security.log": { label: "安全紀錄", description: "回報安全處理的頻道，未設定則使用稽核紀錄頻道" },
  "security.log.channel": { label: "紀錄頻道", description: "接收安全回報的文字頻道" },

  "security.status": {
    description: "檢查陷阱頻道是否能正常運作",
    messages: {
      "heading": "**安全狀態**",
      "no-guild": "伺服器尚未載入，請稍後再試",
      "on": "✅ 陷阱頻道已開啟",
      "off": "ℹ️ 陷阱頻道已關閉",
      "no-channel": "⚠️ 尚未設定頻道",
      "channel-missing": "⚠️ 陷阱頻道已不存在，請重新設定",
      "channel": "✅ 正在監看 {channel}",
      "everyone-cannot-post": "⚠️ 成員無法在 {channel} 發言，所以不會攔到任何人，請讓所有人可以檢視並發言",
      "bot-no-access": "⚠️ 我無法在 {channel} 檢視或管理訊息",
      "missing-permission": "⚠️ 我缺少「{action}」所需的 {permission} 權限",
      "missing-sweep-permission": "⚠️ 我缺少「管理訊息」權限，無法刪除對方的其他訊息",
      "no-log": "ℹ️ 尚未設定紀錄頻道（或稽核紀錄頻道），處理結果不會回報",
      "log": "✅ 回報會送到 {channel}",
      "log-unavailable": "⚠️ 我無法在紀錄頻道發言",
    },
  },
};
