import type { Language } from "./language.js";

export const chatDeliveryText = {
  en: { partial: "(Only part of this reply was delivered.)", preview: "Generating your image…" },
  "zh-TW": { partial: "（這則回覆只送出了部分內容。）", preview: "正在產生圖片……" },
  ja: { partial: "（この返信は一部のみ送信されました。）", preview: "画像を生成しています…" },
} satisfies Record<Language, { partial: string; preview: string }>;
