import type { SettingsTextCatalog } from "../catalog.js";

const memoryModes = {
  shared: "共用：記憶範圍由模型判斷",
  isolated: "隔離：記憶只留在這個頻道",
  session_only: "僅限當次：不寫入長期記憶",
  disabled: "停用：不讀取也不寫入記憶",
};

export const zhTWMemory: SettingsTextCatalog = {
  "memory.context-opt-out": {"label": "上下文排除名單", "description": "以 Discord 頻道可見性決定上下文範圍；互動身分組僅決定誰能觸發機器人。"},
  "memory.context-opt-out.roles": {"label": "排除身分組", "description": "不收集這些身分組的訊息與表情回應，也不使用包含其來源的記憶。"},
  "memory.context-opt-out.users": {"label": "排除使用者 ID", "description": "以逗號分隔 Discord 使用者 ID；留空清除。", "messages": {"invalid": "請輸入以逗號或空白分隔的 Discord 使用者 ID。"}},
  "memory.impressions": {
    label: "印象與共同經歷",
    description: "來源仍可使用時，保留有依據的過往記憶。",
    messages: { behavior: "啟用記憶淡化後，較舊的興趣與語氣印象會較少被回想起來。只要來源仍有效且可存取，過往事件仍可供回憶。舊興趣不應被當成現在的偏好。讀取或重新整理印象，不會讓依據變新；來源被刪除或到期後，就不能再支持該印象。" },
  },
  "memory.advanced": { label: "進階記憶設定", description: "調整記憶淡化速度與舊版紀錄的清理時間。" },
  "memory.advanced.half-life": { label: "淡化半衰期（天）", description: "淡化的回憶權重每隔幾天減半；僅在啟用記憶淡化時生效。" },
  "memory.advanced.history": { label: "舊版本保留天數", description: "不再使用的角色紀錄版本在幾天後清除；不影響使用中的紀錄。" },
  "memory.sharing": { label: "共享個人記憶", description: "依各頻道的記憶模式，分享新的個人事實。" },
  "memory.sharing.enabled": { label: "共享個人記憶", description: "既有私人記憶不會因此公開。" },
  "memory": { title: "記憶", description: "機器人會回顧和記住的內容" },
  "memory.channel-history": { label: "頻道歷史", description: "把最近的頻道訊息交給模型，作為接話背景。" },
  "memory.channel-history.enabled": { label: "頻道歷史", description: "開啟或關閉頻道歷史" },
  "memory.channel-history.limit": { label: "訊息數", description: "讀取最近幾則訊息；角色的擴充視窗可另行設定。" },

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
