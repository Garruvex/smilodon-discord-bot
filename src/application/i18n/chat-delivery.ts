import type { Language } from "./language.js";

export const chatDeliveryText = {
  en: { partial: "(Only part of this reply was delivered.)" },
  "zh-TW": { partial: "（這則回覆只送出了部分內容。）" },
  ja: { partial: "（この返信は一部のみ送信されました。）" },
} satisfies Record<Language, { partial: string }>;
