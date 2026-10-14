import { characterModuleIds } from "../../chat/character-settings.js";
import type { Language } from "../language.js";
import type { SettingsTextCatalog, SettingsNodeText } from "./catalog.js";

const moduleLabels: Record<Language, readonly string[]> = {
  en: ["Character canon", "Relationships", "Held thoughts", "Natural recall", "Event follow-ups", "Fading trivia", "Voice check", "Message shape", "Mood", "Implicit addressing", "Group behavior", "Fictional daily sketch", "Evaluation"],
  "zh-TW": ["角色設定紀錄", "人際印象", "暫存想法", "自然回憶", "事件追問", "淡化瑣事", "語氣檢查", "訊息分段", "心情", "隱含對話對象", "群體對話", "虛構日常", "評估工具"],
  ja: ["キャラクター設定", "人間関係", "保留する考え", "自然な記憶", "イベントの確認", "細かな記憶の減衰", "口調チェック", "メッセージ分割", "気分", "暗黙の呼びかけ", "グループ会話", "架空の日常", "評価ツール"],
};
const fields: Record<string, readonly [string, string, string]> = {
  probes: ["Scheduled interview probes", "定期角色訪談", "定期インタビュー"],
  enabled: ["Enabled", "啟用", "有効"], budget: ["Character budget", "字元上限", "文字数上限"], freeze: ["Freeze new canon entries", "停止新增設定", "新規設定の追加を停止"],
  shadow: ["Shadow only", "僅觀察不發言", "観察のみ"], interval: ["Refresh / decay minutes", "更新／衰減分鐘", "更新・減衰の分数"], threshold: ["Motivation threshold (%)", "發言意願門檻（％）", "発言意欲の基準（％）"],
  hold: ["Hold seconds", "暫存秒數", "保留する秒数"], "max-per-day": ["Maximum per day", "每日上限", "一日の上限"], "min-delay": ["Delay after event (minutes)", "事件後等待分鐘", "イベント後の待機分数"],
  "half-life": ["Half-life days", "半衰期天數", "半減期の日数"], strictness: ["Repair mode", "修正方式", "修正方法"], "max-messages": ["Maximum messages", "訊息數上限", "メッセージ数の上限"], "max-delay": ["Total delay (milliseconds)", "總延遲毫秒", "遅延の合計（ミリ秒）"],
  "include-others": ["Include other participants", "包含其他參與者", "他の参加者を含む"], minutes: ["Context window minutes", "上下文分鐘", "会話履歴の分数"], gap: ["New segment after silence (minutes)", "分段靜默分鐘", "会話を区切る無言時間"], messages: ["Context message limit", "上下文訊息上限", "会話履歴の件数"], summary: ["Running summary", "持續摘要", "継続する要約"], "decision-messages": ["Decision window messages", "判斷視窗訊息數", "判断用の履歴件数"],
  channel: ["Channel", "頻道", "チャンネル"], module: ["Module", "模組", "モジュール"], reset: ["Reset override", "重設覆寫", "上書きをリセット"], operation: ["Action", "操作", "操作"], id: ["Record ID", "紀錄 ID", "記録 ID"], statement: ["Updated statement", "修改內容", "更新した内容"],
};
export function characterSettingsText(language: Language): SettingsTextCatalog {
  const column = language === "zh-TW" ? 1 : language === "ja" ? 2 : 0;
  const description = ["Optional character behavior. Defaults off; dependencies and channel exclusions apply.", "選用角色功能，預設關閉；須滿足依賴並遵守頻道限制。", "任意のキャラクター機能。初期設定は無効。依存条件とチャンネル制限に従います。"][column]!;
  const catalog: Record<string, SettingsNodeText> = { character: { title: ["Character", "角色", "キャラクター"][column]!, description } };
  const messages = {
    missing: ["Choose a channel and module.", "請選擇頻道及模組。", "チャンネルとモジュールを選択してください。"][column]!,
    done: ["Character setting updated.", "角色設定已更新。", "キャラクター設定を更新しました。"][column]!,
    unavailable: ["Character runtime is unavailable.", "角色功能尚未可用。", "キャラクター機能を利用できません。"][column]!,
  };
  const nodes = ["controls", "context", ...characterModuleIds, "channel", "ledger", "status"];
  for (const node of nodes) {
    const index = characterModuleIds.indexOf(node as typeof characterModuleIds[number]);
    const label = index >= 0 ? moduleLabels[language][index]! : ({ controls: ["Master switch", "總開關", "全体の設定"], context: ["Conversation context", "對話上下文", "会話の文脈"],
      channel: ["Channel overrides", "頻道覆寫", "チャンネル上書き"], ledger: ["Canon ledger", "角色紀錄管理", "キャラクター設定の管理"], status: ["Dependencies and status", "依賴及狀態", "依存条件と状態"] } as Record<string, string[]>)[node]![column]!;
    catalog[`character.${node}`] = { label, description, messages };
    const extras: Record<string, readonly string[]> = { canon: ["freeze"], relationships: ["interval"], thoughts: ["shadow", "threshold", "hold"],
      callbacks: ["max-per-day", "min-delay"], fading: ["half-life"], voice: ["strictness"], "message-shape": ["max-messages", "max-delay"], mood: ["interval"], addressing: ["shadow", "include-others"], evaluation: ["probes", "interval"] };
    const options = index >= 0 ? ["enabled", "budget", ...(extras[node] ?? [])] : ({ controls: ["enabled"], context: ["enabled", "minutes", "gap", "messages", "budget", "summary", "shadow", "decision-messages"],
      channel: ["channel", "module", "enabled", "reset"], ledger: ["operation", "module", "channel", "id", "statement"], status: ["channel"] } as Record<string, string[]>)[node]!;
    for (const field of options) { const labels = fields[field]!; catalog[`character.${node}.${field}`] = { label: labels[column], description: labels[column],
      ...(field === "strictness" ? { choices: { trim: ["Trim safe phrases", "移除安全套語", "定型表現を除去"][column]!, regenerate: ["Regenerate once", "重新生成一次", "一度だけ再生成"][column]! } } : {}),
      ...(field === "module" ? { choices: node === "ledger" ? Object.fromEntries(["canon", "mood", "daily-sketch"].map((id) => [id, moduleLabels[language][characterModuleIds.indexOf(id as typeof characterModuleIds[number])]!]))
        : { ...Object.fromEntries(characterModuleIds.map((id, i) => [id, moduleLabels[language][i]!])), master: ["Master switch", "總開關", "全体の設定"][column]!, context: ["Conversation context", "對話上下文", "会話の文脈"][column]! } } : {}),
      ...(field === "operation" ? { choices: { list: ["List", "列出", "一覧"][column]!, edit: ["Edit", "修改", "編集"][column]!, delete: ["Delete", "刪除", "削除"][column]!, clear: ["Clear canon", "清除角色紀錄", "設定記録を消去"][column]! } } : {}),
    };
    }
  }
  catalog["character.context"]!.description = ["Includes bystanders' messages in provider requests. Enable only after server disclosure.", "將其他人的訊息送至模型供應商，請先向伺服器成員揭露。", "他の参加者のメッセージもモデルに送信します。サーバーで説明してから有効にしてください。"][column]!;
  catalog["character.daily-sketch"]!.description = ["Optional fictional daily life from lore. Never real-world actions or events with members.", "依角色背景建立選用虛構日常，不包含真實行動或與成員的事件。", "設定に基づく任意の架空の日常。現実の行動や参加者との出来事は作りません。"][column]!;
  for (const [node, labels] of Object.entries({ relationships: ["Impression refresh minutes", "人際印象更新分鐘", "印象の更新間隔（分）"],
    mood: ["Mood decay minutes", "心情衰減分鐘", "気分が薄れる時間（分）"], evaluation: ["Probe interval minutes (daily by default)", "訪談間隔分鐘（預設每日）", "インタビューの間隔（分、初期設定は一日）"] }))
    catalog[`character.${node}.interval`] = { label: labels[column]!, description: labels[column]! };
  return catalog;
}
