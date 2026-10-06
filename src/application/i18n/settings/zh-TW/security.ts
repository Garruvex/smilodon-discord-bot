import type { SettingsTextCatalog } from "../catalog.js";

const windows = { "10s": "10 秒", "30s": "30 秒", "1m": "1 分鐘", "5m": "5 分鐘" };
const actions = { timeout: "禁言", kick: "踢出", ban: "封鎖" };
const deleteWindows = { "off": "關閉", "10m": "最近 10 分鐘", "30m": "最近 30 分鐘", "1h": "最近 1 小時" };
const timeouts = { "1h": "1 小時", "1d": "1 天", "7d": "7 天", "28d": "28 天" };

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

  "security.spam": { label: "跨頻道洗版", description: "攔截短時間內在多個頻道貼出相同訊息的帳號" },
  "security.spam.enabled": { label: "跨頻道洗版", description: "開啟或關閉洗版偵測" },
  "security.spam.channels": { label: "頻道數", description: "相同訊息出現在幾個不同頻道才算（2-10）" },
  "security.spam.window": { label: "時間內", description: "要在多短的時間內發生", choices: windows },
  "security.spam.action": {
    label: "處理方式",
    description: "對這麼做的帳號如何處理，「僅記錄」只回報，可用來安全地試用",
    choices: { report: "僅記錄", ...actions },
  },
  "security.spam.delete-history": {
    label: "刪除其近期訊息",
    description: "除了重複的訊息外，要往回刪除對方多久以內的其他訊息",
    choices: deleteWindows,
  },
  "security.spam.timeout-duration": { label: "禁言時間", description: "禁言的長度", choices: timeouts },

  "security.links": {
    label: "連結檢查",
    description: "刪除含有封鎖網站、仿冒網址或其他伺服器邀請的訊息",
  },
  "security.links.enabled": { label: "連結檢查", description: "開啟或關閉連結檢查" },
  "security.links.action": {
    label: "處理方式",
    description: "對貼出的帳號如何處理，「僅記錄」不做任何事，「刪除訊息」只刪訊息",
    choices: { report: "僅記錄", delete: "刪除訊息", ...actions },
  },
  "security.links.delete-history": {
    label: "刪除其近期訊息",
    description: "處理方式不只刪除時，要往回刪除對方多久以內的其他訊息",
    choices: deleteWindows,
  },
  "security.links.timeout-duration": { label: "禁言時間", description: "禁言的長度", choices: timeouts },
  "security.links.blocked-domains": {
    label: "封鎖的網站",
    description: "一律拒絕的網站，用逗號或空格分隔，輸入 none 可清空",
    messages: {
      "invalid": "「{entry}」不是網站名稱，請使用像 example.com 的格式",
      "too-many": "網站太多了，最多 {max} 個",
    },
  },
  "security.links.allowed-domains": {
    label: "允許的網站",
    description: "即使看起來可疑也不會拒絕的網站，輸入 none 可清空",
    messages: {
      "invalid": "「{entry}」不是網站名稱，請使用像 example.com 的格式",
      "too-many": "網站太多了，最多 {max} 個",
    },
  },
  "security.links.suspicious": {
    label: "可疑網址",
    description: "同時拒絕仿冒品牌的網址、混用字母的網址與直接使用 IP 的連結",
  },
  "security.links.invites": { label: "其他伺服器的邀請", description: "同時拒絕其他 Discord 伺服器的邀請" },

  "security.raid": { label: "突襲防護", description: "偵測短時間大量帳號加入，並可處理這些帳號" },
  "security.raid.enabled": { label: "突襲防護", description: "開啟或關閉突襲防護" },
  "security.raid.joins": { label: "加入人數", description: "時間內加入幾人算突襲（3-50）" },
  "security.raid.window": { label: "時間內", description: "這段時間的長度", choices: windows },
  "security.raid.action": {
    label: "處理方式",
    description: "對加入者如何處理，「僅通知」只通知管理員",
    choices: { alert: "僅通知", ...actions },
  },
  "security.raid.account-age-days": {
    label: "僅限帳號新於（天）",
    description: "只處理建立不到這麼多天的帳號，0 表示處理所有加入者（0-30）",
  },
  "security.raid.timeout-duration": { label: "禁言時間", description: "禁言的長度", choices: timeouts },

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
      "spam-missing-delete": "⚠️ 我缺少「管理訊息」權限，無法刪除洗版訊息",
      "links-missing-delete": "⚠️ 我缺少「管理訊息」權限，無法刪除含被拒絕連結的訊息",
      "no-log": "ℹ️ 尚未設定紀錄頻道（或稽核紀錄頻道），處理結果不會回報",
      "log": "✅ 回報會送到 {channel}",
      "log-unavailable": "⚠️ 我無法在紀錄頻道發言",
    },
  },
};
