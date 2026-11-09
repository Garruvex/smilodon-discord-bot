import type { ChannelHistoryMessage } from "./chat-provider.js";
import type { ContextualInterpretation } from "./contextual-decision-contract.js";

export interface ContextualReplayCase {
  id: string; language: "zh-TW" | "en" | "ja"; scenario: string; events: ChannelHistoryMessage[]; current: ChannelHistoryMessage;
  expectedRelationships: readonly ContextualInterpretation["relationship"][]; textAllowed: boolean;
}
const copy = {
  "zh-TW": { pending: "你想先測第一個還是第二個方案？", answer: "第二個", correction: "我是在修你ㄟ，你剛剛壞掉了不回他，跟生日沒關係", repair: "所以你修好了嗎？可以回我嗎？", group: "遊戲更新出了，有人試過嗎？", elsewhere: "Bob，你剛剛選了哪個？", unknown: "好了嗎？", thanks: "謝謝！", closing: "我不是在問你，我是在跟 Bob 說話", done: "第二個方案的結果已經確認了。", original: "請幫忙確認第二個測試方案。" },
  en: { pending: "Would you like to test the first or second option?", answer: "The second one", correction: "I was fixing you because you were broken and did not answer them. This has nothing to do with the birthday.", repair: "Are you fixed now? Can you reply to me?", group: "The game update is out. Has anyone tried it?", elsewhere: "Bob, which option did you pick?", unknown: "Is it ready?", thanks: "Thanks!", closing: "I was not asking you. I was talking to Bob.", done: "The results for the second option are confirmed.", original: "Please check the second test option." },
  ja: { pending: "最初と二番目のどちらをテストしますか？", answer: "二番目", correction: "直していたのは君だよ。さっき壊れて彼に返事をしなかった。誕生日とは関係ない。", repair: "もう直った？返事できる？", group: "ゲームの更新が出たね。誰か試した？", elsewhere: "Bob、どちらを選んだ？", unknown: "もうできた？", thanks: "ありがとう！", closing: "あなたには聞いてない。Bob と話していた。", done: "二番目の結果が確認できました。", original: "二番目のテスト結果を確認してください。" },
} as const;

// 8 situations × 3 languages × 3 gaps × 3 speaker contexts = 216 synthetic
// variations. This is a controlled matrix, not 216 independent human dialogs.
export function contextualReplayCases(): ContextualReplayCase[] {
  const result: ContextualReplayCase[] = [];
  for (const language of ["zh-TW", "en", "ja"] as const) for (const gap of [3000, 16 * 60000, 2 * 86400000])
    for (const speaker of ["same", "other", "interleaved"] as const)
      for (const scenario of ["answer", "correction", "repair", "group", "elsewhere", "unknown", "thanks", "closing"] as const) {
        const text = copy[language]; const base = 1700000000000; const actor = "1000000000000000100"; const bot = "1000000000000000200";
        const originalActor = speaker === "other" || scenario === "elsewhere" ? "1000000000000000300" : actor;
        const event = (id: string, at: number, authorId: string, content: string): ChannelHistoryMessage => ({ messageId: id, timestampMs: at, authorId,
          authorDisplayName: authorId === bot ? "Pinecone" : authorId === actor ? "Alice" : "Bob", content, imageCount: 0,
          author: { id: authorId, displayName: authorId === bot ? "Pinecone" : "Human", roleNames: [], kind: authorId === bot ? "bot" : "human" } });
        const original = event("1000000000000000001", base, originalActor, text.original);
        const reply = { ...event("1000000000000000002", base + 1000, bot, scenario === "thanks" ? text.done : text.pending),
          replyToMessageId: original.messageId, replyToAuthorId: originalActor };
        const isolated = scenario === "unknown" || scenario === "group";
        const events = isolated ? [] : [original, reply];
        if (!isolated && speaker === "interleaved") events.push(event("1000000000000000003", base + gap - 1, "1000000000000000300", "Bob: the weather is nice today."));
        const current = event("1000000000000000004", base + gap, actor, text[scenario]);
        if (scenario === "elsewhere") { current.replyToMessageId = original.messageId; current.replyToAuthorId = originalActor; }
        const relationships: ContextualInterpretation["relationship"][] = scenario === "group" ? ["group"] : scenario === "unknown" ? ["unclear"] :
          scenario === "elsewhere" || scenario === "closing" ? ["elsewhere", "unclear"] : scenario === "correction" || scenario === "repair" ? ["followup"] :
          speaker !== "other" ? ["followup"] : ["unclear"];
        result.push({ id: `${language}-${scenario}-${gap}-${speaker}`, language, scenario, events, current,
          expectedRelationships: relationships, textAllowed: !["unknown", "elsewhere", "closing", "thanks"].includes(scenario) && !(scenario === "answer" && speaker === "other") });
      }
  return result;
}
