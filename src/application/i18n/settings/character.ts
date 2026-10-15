import { characterModuleIds } from "../../chat/character-settings.js";
import type { Language } from "../language.js";
import type { SettingsTextCatalog, SettingsNodeText } from "./catalog.js";

const moduleLabels: Record<Language, readonly string[]> = {
  en: ["Character canon", "Relationships", "Held thoughts", "Natural recall", "Event follow-ups", "Memory fading", "Voice check", "Message shape", "Mood", "Implicit addressing", "Group behavior", "Fictional daily sketch", "Evaluation"],
  "zh-TW": ["角色設定紀錄", "人際印象", "暫存想法", "自然回憶", "事件追問", "記憶淡化", "語氣檢查", "訊息分段", "心情", "隱含對話對象", "群體對話", "虛構日常", "評估工具"],
  ja: ["キャラクター設定", "人間関係", "保留する考え", "自然な記憶", "イベントの確認", "記憶の減衰", "口調チェック", "メッセージ分割", "気分", "暗黙の呼びかけ", "グループ会話", "架空の日常", "評価ツール"],
};
const fields: Record<string, readonly [string, string, string]> = {
  probes: ["Scheduled interview probes", "定期角色訪談", "定期インタビュー"],
  enabled: ["Enabled", "啟用", "有効"], budget: ["Context limit (chars)", "背景字數上限", "文脈の文字数上限"], freeze: ["Freeze new canon entries", "停止新增設定", "新規設定の追加を停止"],
  shadow: ["Preview decisions", "試算模式", "判定のみ"], interval: ["Refresh / decay minutes", "更新／衰減分鐘", "更新・減衰の分数"], threshold: ["Motivation threshold (%)", "發言意願門檻（％）", "発言意欲の基準（％）"],
  hold: ["Hold seconds", "暫存秒數", "保留する秒数"], "max-per-day": ["Maximum per day", "每日上限", "一日の上限"], "min-delay": ["Delay after event (minutes)", "事件後等待分鐘", "イベント後の待機分数"],
  "half-life": ["Half-life days", "半衰期天數", "半減期の日数"], strictness: ["Repair mode", "修正方式", "修正方法"], "max-messages": ["Maximum messages", "訊息數上限", "メッセージ数の上限"], "max-delay": ["Total delay (milliseconds)", "總延遲毫秒", "遅延の合計（ミリ秒）"],
  "include-others": ["Include other participants", "包含其他參與者", "他の参加者を含む"], minutes: ["Context window minutes", "上下文分鐘", "会話履歴の分数"], gap: ["New segment after silence (minutes)", "分段靜默分鐘", "会話を区切る無言時間"], messages: ["Recent-message target", "背景訊息目標數", "会話履歴の目標件数"], summary: ["Running summary", "持續摘要", "継続する要約"], "decision-messages": ["Decision window messages", "判斷視窗訊息數", "判断用の履歴件数"],
  channel: ["Channel", "頻道", "チャンネル"], module: ["Module", "模組", "モジュール"], reset: ["Reset override", "重設覆寫", "上書きをリセット"], operation: ["Action", "操作", "操作"], id: ["Record ID", "紀錄 ID", "記録 ID"], statement: ["Updated statement", "修改內容", "更新した内容"],
};
type LocalizedText = readonly [string, string, string];
const nodeDescriptions: Record<string, LocalizedText> = {
  character: ["Character continuity, memory and timing.", "角色的一致性、回憶方式及接話時機。", "キャラクターの一貫性、記憶、発言のタイミング。"],
  controls: ["Switch selected character features together.", "一併開關已選用的角色功能。", "選択済みの機能をまとめて切り替えます。"],
  context: ["Extend recent chat and add summaries.", "擴充最近對話的範圍，並可補上較早內容的摘要。", "最近の会話を広く参照し、要約を添えます。"],
  canon: ["Keep self-descriptions consistent.", "讓角色對自身的描述前後一致。", "自己紹介や好みを一貫させます。"],
  relationships: ["Recall past topics and events from member memories.", "依成員的記憶回顧過往話題與事件。", "参加者の記憶から過去の話題や出来事を振り返ります。"],
  thoughts: ["Wait for a good opening to speak.", "先保留想說的話，等適合的時機再接話。", "発言のタイミングを待ちます。"],
  "recall-style": ["Recall highlights and hedge uncertainty.", "自然提起記憶重點，不確定時保留語氣或詢問。", "記憶の要点を話し、不確かな点は確認します。"],
  callbacks: ["Ask how a member's event went.", "在成員提過的事件結束後，關心後續情況。", "参加者のイベント後の様子を尋ねます。"],
  fading: ["Gradually lower recall priority for old impressions and minor memories.", "逐漸降低舊印象與瑣碎經歷的回憶優先度。", "古い印象や細かな記憶を思い出す優先度を徐々に下げます。"],
  voice: ["Reduce assistant-like casual phrasing.", "減少日常回覆中的助理套語及制式格式。", "日常会話の定型句や書式を減らします。"],
  "message-shape": ["Split casual replies into shorter parts.", "把日常回覆拆成幾則較短的訊息。", "日常の返信を短く分けます。"],
  mood: ["Let chat affect mood temporarily.", "讓近期互動稍微影響語氣，再逐漸恢復平常心情。", "会話を気分に反映し、徐々に戻します。"],
  addressing: ["Recognize follow-ups without a ping.", "判斷沒有標記的接續訊息是否在對機器人說話。", "メンションのない呼びかけを判断します。"],
  group: ["Match the room's pace and speakers.", "配合多人對話的節奏，分清楚誰在說什麼。", "会話のペースに合わせ、話者を区別します。"],
  "daily-sketch": ["Create a fictional day from lore.", "依角色背景建立當天一致的虛構日常。", "設定に沿った架空の一日を作ります。"],
  evaluation: ["Flag replies and run private interviews.", "檢查被標記的回覆，並私下進行角色訪談。", "返信の指摘と非公開の質問で評価します。"],
  channel: ["Restrict selected features per channel.", "為指定頻道停用伺服器已開啟的角色功能。", "チャンネルごとに有効な機能を絞ります。"],
  ledger: ["Manage canon, mood and fictional days.", "查看或修改角色設定、心情及虛構日常紀錄。", "設定・気分・架空の日常の記録を管理します。"],
  status: ["Show active features and unmet needs.", "查看指定頻道有哪些功能生效，以及未生效的原因。", "有効な機能と無効の理由を表示します。"],
};
const fieldDescriptions: Record<string, LocalizedText> = {
  enabled: ["Use this feature.", "在聊天中使用這項功能。", "会話でこの機能を使います。"],
  budget: ["Maximum context characters.", "提供的背景字數上限。", "提供する文脈の文字数上限。"],
  freeze: ["Stop learning; keep existing canon.", "停止學習新紀錄，既有角色紀錄仍會使用。", "新規学習を止め、既存の設定は使います。"],
  shadow: ["Log decisions before using them live.", "先記錄判斷結果，再決定是否用於實際對話。", "実際に使う前に判定を記録します。"],
  interval: ["Minutes between updates.", "兩次更新之間的分鐘數。", "更新の間隔（分）。"],
  threshold: ["Minimum motivation to keep a thought.", "保留想法的最低意願，越高越挑選。", "発言意欲の下限。高いほど厳選します。"],
  hold: ["Seconds before an unsaid thought expires.", "超過這些秒數便捨棄尚未說出的想法。", "未発言の候補が消えるまでの秒数。"],
  "max-per-day": ["Event follow-ups per server day.", "整個伺服器一天最多進行幾次事件追問。", "サーバー全体の一日のイベント確認上限。"],
  "min-delay": ["Wait minutes after the event day ends.", "事件當天結束後，至少等待幾分鐘再關心。", "イベント当日終了後の待機時間（分）。"],
  "half-life": ["Days until a minor memory's weight halves.", "瑣碎經歷的回憶權重每隔幾天減半。", "細かな記憶の重みが半分になる日数。"],
  strictness: ["Trim phrases or rewrite severe formatting.", "移除套語，或針對嚴重制式格式重新生成一次。", "定型句を除去するか、強い書式を直します。"],
  "max-messages": ["Reply parts; 1 keeps a single message.", "回覆最多拆成幾則；1 表示不分段。", "返信の最大分割数。1なら分割しません。"],
  "max-delay": ["Total added delay between parts, in ms.", "分段訊息增加的總等待時間，單位毫秒。", "返信の間に加える待機時間の合計（ミリ秒）。"],
  "include-others": ["Include other recent participants.", "也判斷其他近期參與者的訊息是否在對機器人說話。", "他の最近の参加者の呼びかけも判断します。"],
  minutes: ["Minutes of recent chat to include.", "要參考最近幾分鐘的頻道對話。", "直近何分のチャンネル会話を参照するか。"],
  gap: ["Minutes of silence before a new segment.", "沉默超過幾分鐘後，視為新的一段對話。", "この分数の無言時間で新しい会話として区切ります。"],
  messages: ["Recent-message target; keep short exchanges.", "最近訊息的目標上限；短對話會盡量完整保留。", "履歴の目標件数。短い会話は保ちます。"],
  summary: ["Summarize earlier recent-chat messages.", "為最近對話中較早的內容補上一段摘要。", "最近の会話の古い部分に要約を添えます。"],
  "decision-messages": ["Messages used to judge timing and targets.", "用最近幾則訊息判斷接話時機與回覆對象。", "発言と返信先の判断に使う履歴の件数。"],
  probes: ["Schedule private interview questions.", "定期生成私下的角色訪談回答，供管理員檢查。", "非公開の質問に定期的に回答します。"],
  channel: ["Channel to inspect or configure.", "要查看或設定的頻道。", "確認・設定するチャンネル。"],
  module: ["Feature or record category.", "要設定的功能或紀錄類別。", "設定する機能または記録の種類。"],
  reset: ["Restore the server setting.", "移除此項覆寫，重新使用伺服器設定。", "上書きを消し、サーバー設定に戻します。"],
  operation: ["List, edit, delete, or clear this category.", "列出、修改、刪除，或清空這個類別的全部紀錄。", "この種類の記録を一覧・編集・削除・全消去します。"],
  id: ["Record ID shown by the list action.", "列出紀錄時顯示的 ID。", "一覧に表示された記録のID。"],
  statement: ["New text for the selected record.", "用來取代所選紀錄的新內容。", "選択した記録を置き換える内容。"],
};
const optionDescriptions: Record<string, LocalizedText> = {
  "controls.enabled": ["Behavior switch; review tools are separate.", "控制角色行為總開關；評估工具可獨立使用。", "全体スイッチ。評価ツールは独立です。"],
  "context.enabled": ["Extend history; off also disables history.", "開啟擴充視窗；關閉時也會停用頻道歷史。", "履歴を拡張します。無効なら履歴も止まります。"],
  "context.budget": ["Characters of recent channel chat.", "最近頻道對話最多保留多少字。", "最近のチャンネル会話を含める文字数の上限。"],
  "context.shadow": ["Log model segments; use time gaps.", "使用時間間隔分段，模型的分段判斷先只記錄。", "時間で区切り、モデルの判断は記録だけにします。"],
  "thoughts.shadow": ["Evaluate thoughts without saying them.", "評估候選想法，暫時不主動說出它們。", "候補を評価し、自発的には発言しません。"],
  "addressing.shadow": ["Log addressing; keep current replies.", "記錄對話對象的判斷，先不套用於實際接話。", "判定を記録し、従来の返信方法を使います。"],
  "relationships.enabled": ["Requires memory sharing.", "須先開啟記憶共享。", "記憶の共有が必要です。"],
  "thoughts.enabled": ["Needs addressing and participation.", "須啟用對話對象判斷及聊天參與。", "呼びかけの判定と会話参加が必要です。"],
  "callbacks.enabled": ["Needs memory sharing and continuation.", "須啟用記憶共享及繼續對話。", "記憶の共有と会話の継続が必要です。"],
  "addressing.enabled": ["Needs history and continuation.", "須啟用頻道歷史及繼續對話。", "履歴と会話の継続が必要です。"],
  "daily-sketch.enabled": ["Requires character canon.", "須先啟用角色設定紀錄。", "キャラクター設定の記録が必要です。"],
  "channel.enabled": ["Allow or block server-enabled features.", "允許伺服器已開啟的功能，或在此頻道停用。", "有効な機能をここで許可・停止します。"],
  "ledger.channel": ["Channel for viewing its mood records.", "要查看心情紀錄的頻道。", "気分の記録を確認するチャンネル。"],
};
export function characterSettingsText(language: Language): SettingsTextCatalog {
  const column = language === "zh-TW" ? 1 : language === "ja" ? 2 : 0;
  const description = nodeDescriptions.character![column];
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
      channel: ["Channel overrides", "頻道覆寫", "チャンネル上書き"], ledger: ["Character records", "角色紀錄管理", "キャラクターの記録"], status: ["Feature status", "功能狀態", "機能の状態"] } as Record<string, string[]>)[node]![column]!;
    catalog[`character.${node}`] = { label, description: nodeDescriptions[node]![column], messages };
    const extras: Record<string, readonly string[]> = { canon: ["freeze"], relationships: ["interval"], thoughts: ["shadow", "hold"],
      callbacks: ["max-per-day", "min-delay"], voice: ["strictness"], "message-shape": ["max-messages", "max-delay"], mood: ["interval"], addressing: ["shadow", "include-others"], evaluation: ["probes", "interval"] };
    const options = index >= 0 ? ["enabled", ...(["canon", "relationships", "recall-style", "mood", "group", "daily-sketch"].includes(node) ? ["budget"] : []), ...(extras[node] ?? [])] : ({ controls: ["enabled"], context: ["enabled", "minutes", "gap", "messages", "budget", "summary", "shadow", "decision-messages"],
      channel: ["channel", "module", "enabled", "reset"], ledger: ["operation", "module", "channel", "id", "statement"], status: ["channel"] } as Record<string, string[]>)[node]!;
    for (const field of options) { const labels = fields[field]!; catalog[`character.${node}.${field}`] = { label: labels[column], description: (optionDescriptions[`${node}.${field}`] ?? fieldDescriptions[field])![column],
      ...(field === "strictness" ? { choices: { trim: ["Trim safe phrases", "移除安全套語", "定型表現を除去"][column]!, regenerate: ["Regenerate once", "重新生成一次", "一度だけ再生成"][column]! } } : {}),
      ...(field === "module" ? { choices: node === "ledger" ? Object.fromEntries(["canon", "mood", "daily-sketch"].map((id) => [id, moduleLabels[language][characterModuleIds.indexOf(id as typeof characterModuleIds[number])]!]))
        : { ...Object.fromEntries(characterModuleIds.map((id, i) => [id, moduleLabels[language][i]!])), master: ["Master switch", "總開關", "全体の設定"][column]!, context: ["Conversation context", "對話上下文", "会話の文脈"][column]! } } : {}),
      ...(field === "operation" ? { choices: { list: ["List", "列出", "一覧"][column]!, edit: ["Edit", "修改", "編集"][column]!, delete: ["Delete", "刪除", "削除"][column]!, clear: ["Clear this category", "清空這類紀錄", "この種類を全消去"][column]! } } : {}),
    };
    }
  }
  for (const [node, labels, descriptions] of [
    ["relationships", ["Impression refresh (minutes)", "印象更新間隔（分鐘）", "印象の更新間隔（分）"], ["Minutes between note updates; updating does not reset the age of the evidence.", "同一成員的印象整理間隔；重新整理不會讓依據變新。", "同じ参加者の印象を整理する間隔。整理しても根拠の日時は変わりません。"]],
    ["mood", ["Mood duration (minutes)", "心情持續時間（分鐘）", "気分の持続時間（分）"], ["Minutes until the mood returns to normal.", "這個頻道的心情多久後恢復平常狀態。", "チャンネルの気分が普段の状態に戻るまでの時間。"]],
    ["evaluation", ["Probe interval (minutes)", "訪談間隔（分鐘）", "インタビューの間隔（分）"], ["Question interval; default 1440 (daily).", "訪談間隔；預設 1440 分鐘（每天）。", "定期質問の間隔。初期設定は1440分（一日）です。"]],
  ] as const) catalog[`character.${node}.interval`] = { label: labels[column], description: descriptions[column] };
  return catalog;
}
