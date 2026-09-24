import type { SettingsTextCatalog } from "../catalog.js";

export const zhTWChat: SettingsTextCatalog = {
  "chat": {
    title: "AI 聊天",
    description: "機器人怎麼聊天、能做什麼，以及它是誰",
    messages: { paused: "注意：聊天機器人目前關閉，開啟前這項變更不會生效。" },
  },

  "chat.replies": { title: "回覆", description: "機器人什麼時候回應，以及如何婉拒" },
  "chat.replies.mention-chat": { label: "提及聊天", description: "擁有 AI 聊天身分組的成員提及機器人時回覆" },
  "chat.replies.mention-chat.enabled": { label: "聊天機器人", description: "開啟或關閉這個伺服器的 AI 聊天" },
  "chat.replies.mention-chat.channels": { label: "聊天頻道", description: "允許提及聊天的文字頻道；留空表示所有頻道" },
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
  "chat.replies.reaction-replies.max-wait": { label: "最長等待（分鐘）", description: "最長等待；會在兩者之間隨機選擇" },
  "chat.replies.reaction-replies.min-reactions": { label: "最少反應人數", description: "需要多少人先加上反應" },

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
