import type { SettingsTextCatalog } from "../catalog.js";

const memoryModes = {
  shared: "共用：記憶範圍由模型判斷",
  isolated: "隔離：記憶只留在這個頻道",
  session_only: "僅限當次：不寫入長期記憶",
  disabled: "停用：不讀取也不寫入記憶",
};

export const zhTWMemory: SettingsTextCatalog = {
  "memory": { title: "記憶", description: "機器人會回顧和記住的內容" },
  "memory.channel-history": { label: "頻道歷史", description: "把頻道最近的訊息當作回覆的背景" },
  "memory.channel-history.enabled": { label: "頻道歷史", description: "開啟或關閉頻道歷史" },
  "memory.channel-history.limit": { label: "訊息數", description: "要納入的最近頻道訊息數量" },

  "memory.memory-mode": {
    label: "頻道記憶模式",
    description: "設定頻道記憶的隔離方式",
    messages: {
      missing: "請選擇頻道和模式。",
      done: "{channel} 的記憶模式已設為{mode}。",
    },
  },
  "memory.memory-mode.channel": { label: "頻道", description: "要設定的頻道" },
  "memory.memory-mode.mode": { label: "模式", description: "頻道的記憶模式", choices: memoryModes },

  "memory.context-daily": { label: "每日摘要", description: "每天摘要進記憶的頻道" },
  "memory.context-daily.channels": {
    label: "頻道",
    description: "每天摘要的文字頻道",
    messages: { unavailable: "目前沒有可以摘要頻道的聊天服務，所以無法開啟。" },
  },

  "memory.context-scan": {
    label: "歷史掃描",
    description: "讀取一次頻道的過往訊息，並把摘要存進記憶",
    messages: {
      unavailable: "目前沒有可以摘要頻道的聊天服務，所以無法排入。",
      missing: "請選擇要掃描的頻道。",
      "in-progress": "這個頻道的掃描已經排入或正在進行，請查看背景狀態。",
      completed: "這個頻道的掃描已經完成。開啟「重新開始」可以再跑一次。",
      queued: "{channel} 已排入一次性的歷史掃描，會在背景執行；進度請查看背景狀態。",
      restarted: "{channel} 已重新開始掃描，歷史訊息會重新讀取並摘要。進度請查看背景狀態。",
    },
  },
  "memory.context-scan.channel": { label: "頻道", description: "要掃描的頻道" },
  "memory.context-scan.seed-days": { label: "讀取天數", description: "第一次執行要往回讀幾天（預設 7）" },
  "memory.context-scan.restart": { label: "重新開始", description: "把已完成的掃描從頭再跑一次" },

  "memory.context-remove": {
    label: "停止摘要",
    description: "把頻道從掃描和每日清單移除；已寫入的記憶會保留",
    messages: {
      missing: "請選擇頻道。",
      done: "{channel} 不會再被掃描或摘要。已寫入的記憶會保留。",
    },
  },
  "memory.context-remove.channel": { label: "頻道", description: "要停止摘要的頻道" },

  "memory.context-status": {
    label: "背景狀態",
    description: "正在掃描或摘要的頻道，以及各自上次的執行狀況",
    messages: {
      "provider-available": "服務：可用",
      "provider-unavailable": "服務：無法使用",
      "chatbot-enabled": "聊天機器人：開啟",
      "chatbot-paused": "聊天機器人：關閉（開啟前不會處理）",
      "seed-days": "第一次執行讀取的天數：{days}",
      "none-configured": "沒有設定任何要掃描或每日摘要的頻道。",
      "channel-not-configured": "這個頻道沒有設定掃描或每日摘要。",
      "scan": "掃描：{state}",
      "scan-cursor": "掃描位置：{cursor}",
      "daily": "每日：{state}",
      "daily-cursor": "每日位置（進行中）：{cursor}",
      "daily-high-water": "每日摘要已處理到：{at}",
      "last-success": "上次成功：{at}",
      "last-error": "⚠️ 上次錯誤（{code}）：{error}",
      "state-queued": "已排入",
      "state-running": "執行中",
      "state-complete": "已完成",
      "state-failed": "失敗",
      "state-enabled": "開啟",
    },
  },
  "memory.context-status.channel": { label: "頻道", description: "只顯示一個頻道" },
};
