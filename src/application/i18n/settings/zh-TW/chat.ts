import type { SettingsTextCatalog } from "../catalog.js";

const memoryModes = {
  shared: "共用：記憶範圍由模型判斷",
  isolated: "隔離：記憶只留在這個頻道",
  session_only: "僅限當次：不寫入長期記憶",
  disabled: "停用：不讀取也不寫入記憶",
};

export const zhTWChat: SettingsTextCatalog = {
  "chat": {
    title: "AI 聊天",
    description: "機器人怎麼聊天、能做什麼、記得什麼，以及它是誰",
    messages: { paused: "注意：聊天機器人目前關閉，開啟前這項變更不會生效。" },
  },

  "chat.replies": { title: "回覆", description: "機器人什麼時候回應，以及如何婉拒" },
  "chat.replies.mention-chat": { label: "提及聊天", description: "擁有 AI 聊天身分組的成員提及機器人時回覆" },
  "chat.replies.mention-chat.enabled": { label: "聊天機器人", description: "開啟或關閉這個伺服器的 AI 聊天" },
  "chat.replies.mention-chat.channels": { label: "聊天頻道", description: "允許提及聊天的文字頻道" },
  "chat.replies.mention-chat.cooldown-seconds": { label: "冷卻時間（秒）", description: "每位成員兩次請求之間的間隔" },

  "chat.replies.denied-message": { label: "拒絕訊息", description: "沒有權限的成員提及機器人時看到的內容" },
  "chat.replies.denied-message.message": { label: "訊息", description: "顯示給沒有權限成員的俏皮回覆" },
  "chat.replies.denied-message.link-url": {
    label: "連結網址",
    description: "和訊息一起顯示的 https:// 連結按鈕；輸入 \"none\" 可移除",
    messages: { "not-https": "連結必須是 https:// 網址，或輸入 \"none\" 移除。" },
  },
  "chat.replies.denied-message.link-label": { label: "連結文字", description: "連結按鈕上的文字" },

  "chat.replies.ambient-replies": { label: "環境回覆", description: "有人提到機器人名字時，由機器人判斷是否回應" },
  "chat.replies.ambient-replies.enabled": { label: "環境回覆", description: "開啟或關閉環境回覆" },
  "chat.replies.ambient-replies.cooldown-seconds": { label: "冷卻時間（秒）", description: "每個頻道兩次判斷之間的最短秒數" },

  "chat.replies.reaction-replies": {
    label: "反應回覆",
    description: "機器人的聊天回覆收到表情回應時，判斷是否要再次回覆",
    messages: { "wait-order": "最短等待時間（{min} 分鐘）不能比最長（{max} 分鐘）還長。" },
  },
  "chat.replies.reaction-replies.enabled": { label: "反應回覆", description: "開啟或關閉" },
  "chat.replies.reaction-replies.min-wait": { label: "最短等待（分鐘）", description: "第一次有人加上表情回應後，至少要等待多久" },
  "chat.replies.reaction-replies.max-wait": { label: "最長等待（分鐘）", description: "最長等待時間；機器人會在兩個設定值之間隨機選擇" },

  "chat.replies.history-reactions": { label: "歷史反應", description: "讓機器人對聊天時看到的其他訊息加上反應" },
  "chat.replies.history-reactions.enabled": { label: "歷史反應", description: "開啟或關閉" },

  "chat.abilities": { title: "能力", description: "模型回覆時可以做的事" },
  "chat.abilities.web-search": { label: "網路搜尋", description: "需要時讓模型搜尋公開網路" },
  "chat.abilities.web-search.enabled": { label: "網路搜尋", description: "開啟或關閉" },
  "chat.abilities.include-sources": { label: "附上來源", description: "在回覆中加上網路引用連結" },
  "chat.abilities.include-sources.enabled": { label: "附上來源", description: "開啟或關閉" },
  "chat.abilities.tool-calling": { label: "工具呼叫", description: "讓模型在回覆途中呼叫機器人功能" },
  "chat.abilities.tool-calling.enabled": { label: "工具呼叫", description: "開啟或關閉" },
  "chat.abilities.image-input": { label: "圖片輸入", description: "讓模型看到 Discord 中附加的圖片" },
  "chat.abilities.image-input.enabled": { label: "圖片輸入", description: "開啟或關閉圖片輸入" },
  "chat.abilities.image-input.max-images": { label: "圖片上限", description: "每次請求最多接受的圖片數" },
  "chat.abilities.image-generation": { label: "圖片生成", description: "讓模型在提及聊天中生成圖片" },
  "chat.abilities.image-generation.enabled": { label: "圖片生成", description: "開啟或關閉" },

  "chat.abilities.tools": {
    label: "聊天工具",
    description: "模型可以呼叫的所有工具，以及在這裡是否啟用",
    messages: {
      none: "目前沒有註冊任何聊天工具。",
      heading: "🟢 啟用 · 🔴 在這個伺服器停用",
    },
  },
  "chat.abilities.tool": {
    label: "啟用或停用工具",
    description: "開啟或關閉模型的某個聊天工具",
    messages: {
      unknown: "找不到工具「{name}」。可用的工具：{available}。",
      done: "已停用的聊天工具：{disabled}。",
    },
  },
  "chat.abilities.tool.name": { label: "工具名稱", description: "工具名稱，和工具清單相同" },
  "chat.abilities.tool.enabled": { label: "啟用", description: "模型是否可以呼叫它" },

  "chat.memory": { title: "記憶", description: "機器人會回顧和記住的內容" },
  "chat.memory.channel-history": { label: "頻道歷史", description: "把頻道最近的訊息當作回覆的背景" },
  "chat.memory.channel-history.enabled": { label: "頻道歷史", description: "開啟或關閉頻道歷史" },
  "chat.memory.channel-history.limit": { label: "訊息數", description: "要納入的最近頻道訊息數量" },

  "chat.memory.memory-mode": {
    label: "頻道記憶模式",
    description: "設定頻道記憶的隔離方式",
    messages: {
      missing: "請選擇頻道和模式。",
      done: "{channel} 的記憶模式已設為{mode}。",
    },
  },
  "chat.memory.memory-mode.channel": { label: "頻道", description: "要設定的頻道" },
  "chat.memory.memory-mode.mode": { label: "模式", description: "頻道的記憶模式", choices: memoryModes },

  "chat.memory.context-daily": { label: "每日摘要", description: "每天摘要進記憶的頻道" },
  "chat.memory.context-daily.channels": {
    label: "頻道",
    description: "每天摘要的文字頻道",
    messages: { unavailable: "目前沒有可以摘要頻道的聊天服務，所以無法開啟。" },
  },

  "chat.memory.context-scan": {
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
  "chat.memory.context-scan.channel": { label: "頻道", description: "要掃描的頻道" },
  "chat.memory.context-scan.seed-days": { label: "讀取天數", description: "第一次執行要往回讀幾天（預設 7）" },
  "chat.memory.context-scan.restart": { label: "重新開始", description: "把已完成的掃描從頭再跑一次" },

  "chat.memory.context-remove": {
    label: "停止摘要",
    description: "把頻道從掃描和每日清單移除；已寫入的記憶會保留",
    messages: {
      missing: "請選擇頻道。",
      done: "{channel} 不會再被掃描或摘要。已寫入的記憶會保留。",
    },
  },
  "chat.memory.context-remove.channel": { label: "頻道", description: "要停止摘要的頻道" },

  "chat.memory.context-status": {
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
  "chat.memory.context-status.channel": { label: "頻道", description: "只顯示一個頻道" },

  "chat.persona": { title: "角色", description: "機器人聊天時的身分" },
  "chat.persona.personality": { label: "個性", description: "角色的個性，以 Markdown 檔案提供" },
  "chat.persona.personality.file": {
    label: "個性檔案",
    description: "上傳 personality.md（範本可用範本動作取得）",
    messages: {
      lore: "個性已編譯：{count} 個段落被歸為情境背景，只在相關時送出——{headings}。需要一直套用的內容請移出 `##` 段落。",
    },
  },
  "chat.persona.use-default-personality": {
    label: "使用預設個性",
    description: "移除上傳的個性並改用內建的",
    messages: { done: "已改用預設個性。" },
  },
  "chat.persona.examples": { label: "對話範例", description: "以角色口吻寫的範例對話" },
  "chat.persona.examples.file": { label: "範例檔案", description: "上傳 examples.md（範本可用範本動作取得）" },
  "chat.persona.use-default-examples": {
    label: "移除範例",
    description: "移除上傳的對話範例",
    messages: { done: "已移除上傳的範例。" },
  },
  "chat.persona.template": {
    label: "範本檔案",
    description: "傳送 personality.md 或 examples.md 範本，編輯後再上傳",
    messages: { done: "範本 `{file}`：編輯後用 `{command}` 上傳。" },
  },
  "chat.persona.template.kind": {
    label: "檔案",
    description: "要傳送哪個範本",
    choices: { personality: "個性", examples: "範例" },
  },
  "chat.persona.self-reference-image": { label: "自我參考圖", description: "機器人畫自己時的樣子" },
  "chat.persona.self-reference-image.image": { label: "圖片", description: "PNG、JPEG、WebP 或 GIF，最大 8 MB" },
  "chat.persona.remove-self-reference-image": {
    label: "移除自我參考圖",
    description: "刪除上傳的自我參考圖",
    messages: { done: "已移除自我參考圖。" },
  },
  "chat.persona.persona-drift": { label: "個性漂移", description: "實驗性：讓角色的心情和習慣慢慢演變" },
  "chat.persona.persona-drift.enabled": { label: "個性漂移", description: "開啟或關閉" },
  "chat.persona.reset-persona-drift": {
    label: "重設個性漂移",
    description: "清除角色演變出的心情和習慣，重新開始",
    messages: {
      unavailable: "沒有聊天服務時無法使用個性漂移。",
      done: "個性漂移已重設，角色重新開始。",
    },
  },
};
