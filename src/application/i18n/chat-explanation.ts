import type { ChatExplanation } from "../diagnostics/chat-explanation.js";
import type { Language } from "./language.js";

const copy = {
  en: {
    bookkeeping: "Delivery metadata could not be saved; affected output may be unavailable as future context.",
    unavailable: "Excluded context", legacy_derived: "unverified legacy text", memory: "memory", summaries: "summaries", learned_character: "learned state", images: "images", context_tools: "tools", profile_fields: "profile fields",
    no_record: "No retained record for this message in this channel. Records expire after 24 hours or capacity eviction; this does not prove the bot never received it.",
    delivered: "A text reply was confirmed delivered.", delivery_observed: "At least one text part was delivered; completion is not established by the retained records.",
    partial_delivery: "Part of the text reply was delivered; the full reply was not confirmed.", delivered_unsaved: "The reply was delivered, but conversation state was not saved. Do not resend it automatically.",
    reacted: "A reaction was confirmed; no text delivery is established here.", intentional_silence: "A valid decision chose silence.",
    access_denied: "The recorded request was blocked by an access or scope gate.", feature_disabled: "A required feature was disabled.", duplicate: "A repeated event or social ping was suppressed.",
    source_invalidated: "Source context or privacy state changed; output was suppressed.", suppressed: "The request was suppressed by a recorded gate.",
    provider_failed: "The decision or reply failed; this was not a valid choice to stay silent.", delivery_failed: "Delivery failed; no delivered text is confirmed here.", failed: "The turn failed; the retained record does not establish a more specific cause.",
    interrupted_unknown: "A previous process ended with unfinished work; the final outcome is unknown.", incomplete: "The retained records do not establish a final outcome.",
    partial: "Evidence is incomplete because events were omitted or evicted.", earlier: "Another retained attempt confirms text delivery for this message.",
    context: "History selected/target", unknown: "unknown", failures: "Failed model-event records", fallback: "fallback observed", reason: "Recorded code",
  },
  "zh-TW": {
    bookkeeping: "無法儲存傳送中繼資料；受影響的回覆可能無法作為之後的上下文。",
    unavailable: "排除的上下文", legacy_derived: "未驗證舊文字", memory: "記憶", summaries: "摘要", learned_character: "學習狀態", images: "圖片", context_tools: "工具", profile_fields: "個人資料",
    no_record: "此頻道沒有保留這則訊息的紀錄。紀錄會在 24 小時後或容量不足時移除；這不代表機器人從未收到訊息。",
    delivered: "已確認送出文字回覆。", delivery_observed: "至少一段文字已送出；保留紀錄無法確認是否全部完成。",
    partial_delivery: "已送出部分文字；未確認完整回覆送達。", delivered_unsaved: "回覆已送出，但對話狀態未儲存；請勿自動重送。",
    reacted: "已確認送出表情回應；此處沒有文字送達的證據。", intentional_silence: "有效判斷選擇不發言。",
    access_denied: "紀錄顯示請求遭權限或範圍規則阻擋。", feature_disabled: "必要功能未啟用。", duplicate: "重複事件或社交標記已抑制。",
    source_invalidated: "來源上下文或隱私狀態改變，已停止輸出。", suppressed: "請求遭已記錄的規則抑制。",
    provider_failed: "判斷或回覆失敗，並非有效的沉默選擇。", delivery_failed: "傳送失敗；此處未確認有文字送達。", failed: "此回合失敗；保留紀錄無法證實更具體的原因。",
    interrupted_unknown: "前一程序結束時仍有工作未完成；最終結果未知。", incomplete: "保留紀錄不足以確認最終結果。",
    partial: "部分事件已省略或移除，證據不完整。", earlier: "此訊息的另一筆保留嘗試已確認文字送達。",
    context: "歷史選取／目標", unknown: "未知", failures: "模型失敗事件紀錄數", fallback: "曾使用備援", reason: "紀錄代碼",
  },
  ja: {
    bookkeeping: "送信情報を保存できませんでした。該当する返信を今後の履歴に使えない場合があります。",
    unavailable: "除外した履歴", legacy_derived: "未検証の過去の文字", memory: "記憶", summaries: "要約", learned_character: "学習状態", images: "画像", context_tools: "ツール", profile_fields: "プロフィール",
    no_record: "このチャンネルには該当メッセージの保存記録がありません。記録は24時間後や容量超過時に削除されます。ボットが受信しなかった証拠ではありません。",
    delivered: "文字による返信の送信を確認しました。", delivery_observed: "少なくとも一部の文字は送信済みです。全体の完了は確認できません。",
    partial_delivery: "返信の一部を送信しました。全体の送信は未確認です。", delivered_unsaved: "返信は送信済みですが会話状態を保存できませんでした。自動で再送しないでください。",
    reacted: "リアクションの送信を確認しました。文字の送信は確認されていません。", intentional_silence: "有効な判定で発言しないことを選びました。",
    access_denied: "記録上、権限または対象範囲の条件で停止しました。", feature_disabled: "必要な機能が無効でした。", duplicate: "重複イベントまたは社交的なメンションを抑制しました。",
    source_invalidated: "取得元またはプライバシー状態が変わり、出力を停止しました。", suppressed: "記録された条件により応答を抑制しました。",
    provider_failed: "判定または返信の処理が失敗しました。有効な無言の選択ではありません。", delivery_failed: "送信に失敗しました。文字の到達は確認できません。", failed: "処理が失敗しました。記録から詳しい原因は確定できません。",
    interrupted_unknown: "前のプロセスに未完了の処理がありました。最終結果は不明です。", incomplete: "保存記録では最終結果を確認できません。",
    partial: "省略または削除されたイベントがあり、記録は不完全です。", earlier: "このメッセージの別の保存記録で文字の送信を確認しました。",
    context: "履歴の選択数・目標", unknown: "不明", failures: "モデル失敗イベント数", fallback: "代替処理の記録あり", reason: "記録コード",
  },
} satisfies Record<Language, Record<ChatExplanation["outcome"] | ChatExplanation["unavailable"][number] | "bookkeeping" | "unavailable" | "partial" | "earlier" | "context" | "unknown" | "failures" | "fallback" | "reason", string>>;

export function renderChatExplanation(explanation: ChatExplanation, language: Language = "en"): string {
  const t = copy[language];
  return [t[explanation.outcome], ...(explanation.reason ? [`${t.reason}: ${explanation.reason}`] : []),
    ...(explanation.bookkeepingFailures ? [t.bookkeeping] : []),
    ...(explanation.partialEvidence ? [t.partial] : []), ...(explanation.earlierDeliveryObserved ? [t.earlier] : []),
    ...(explanation.context ? [`${t.context}: ${explanation.context.selected}/${explanation.context.requested ?? t.unknown}${explanation.context.status ? ` (${explanation.context.status})` : ""}`] : []),
    ...(explanation.unavailable.length ? [`${t.unavailable}: ${explanation.unavailable.map((source) => t[source]).join(", ")}.`] : []),
    ...(explanation.modelFailures ? [`${t.failures}: ${explanation.modelFailures}${explanation.fallbackObserved ? `; ${t.fallback}` : ""}.`] : explanation.fallbackObserved ? [t.fallback] : []),
  ].join("\n");
}

// Public/self-service views deliberately project only the outcome. They never
// expose source IDs, another member's restrictions, raw reason codes or traces.
export function renderSafeChatExplanation(explanation: ChatExplanation, language: Language = "en"): string {
  const t = copy[language];
  const outcome = explanation.outcome === "access_denied" || explanation.outcome === "feature_disabled" ? "suppressed" : explanation.outcome;
  return [t[outcome], ...(explanation.partialEvidence ? [t.partial] : []), ...(explanation.earlierDeliveryObserved ? [t.earlier] : [])].join("\n");
}
