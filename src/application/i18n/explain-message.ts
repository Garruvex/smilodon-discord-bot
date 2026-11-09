import type { Language } from "./language.js";

export const explainMessageText = {
  en: { server: "Use this in the server channel containing the message.", invalid: "Use a message ID or link from this server and channel.",
    denied: "This message cannot be explained here. You need current channel/history access and must be its author or a bot administrator.",
    unavailable: "Message explanations are unavailable on this instance.", config: "For current channel configuration, use /settings-participation policy. Retained evidence describes the original attempt, not today's settings." },
  "zh-TW": { server: "請在訊息所在的伺服器頻道使用。", invalid: "請使用此伺服器、此頻道的訊息 ID 或連結。",
    denied: "無法在此說明這則訊息。你須有目前的頻道與歷史讀取權限，且為訊息作者或機器人管理員。",
    unavailable: "此實例目前無法提供訊息說明。", config: "目前的頻道設定可用 /settings-participation policy 查看。保留紀錄說明當時的嘗試，而非現在的設定。" },
  ja: { server: "メッセージがあるサーバーのチャンネルで実行してください。", invalid: "このサーバー・チャンネルのメッセージIDかリンクを指定してください。",
    denied: "このメッセージは説明できません。現在のチャンネル・履歴の閲覧権限と、投稿者またはボット管理者であることが必要です。",
    unavailable: "このインスタンスではメッセージの説明を利用できません。", config: "現在の設定は /settings-participation policy で確認できます。保存記録は当時の試行を示し、現在の設定ではありません。" },
} satisfies Record<Language, Record<"server" | "invalid" | "denied" | "unavailable" | "config", string>>;
