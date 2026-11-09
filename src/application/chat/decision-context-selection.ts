import type { ChannelHistoryMessage, ChatRequest } from "./chat-provider.js";

export interface DecisionContextCoverage { available: number; selected: number; required: number; omittedRequired: number }
// Input is already authorized by the lease. This selector cannot fetch, add
// sources, or infer access from a reference embedded in message text.
export function selectDecisionContext(request: ChatRequest, count: number): { events: ChannelHistoryMessage[]; coverage: DecisionContextCoverage } {
  const current = request.currentBurst?.at(-1);
  const pool = [...new Map([...request.channelHistory, ...request.replyChain].filter((event) =>
    !current || event.messageId !== current.messageId && event.timestampMs <= current.timestampMs).map((event) => [event.messageId, event])).values()]
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const byId = new Map(pool.map((event) => [event.messageId, event]));
  const required = new Map(request.replyChain.filter((event) => byId.has(event.messageId)).map((event) => [event.messageId, event]));
  const references = new Set((current?.content ?? request.message).match(/\d{17,20}/gu) ?? []);
  for (const id of references) { const event = byId.get(id); if (event) required.set(id, event); }
  const text = (current?.content ?? request.message).toLocaleLowerCase();
  const terms = new Set(text.match(/[a-z0-9_]{3,}|[\p{Script=Han}]{2}/gu) ?? []);
  const pairs = pool.filter((event) => event.authorId === request.botUserId && event.replyToMessageId).map((bot) => {
    const human = byId.get(bot.replyToMessageId!);
    const overlap = [...terms].reduce((score, term) => score + Number((bot.content + human?.content).toLocaleLowerCase().includes(term)), 0);
    return { bot, human, score: Number(references.has(bot.messageId) || !!human && references.has(human.messageId)) * 100 +
      overlap * 4 + Number(human?.authorId === request.currentUser.id) * 2 };
  }).filter((pair): pair is typeof pair & { human: ChannelHistoryMessage } => !!pair.human &&
    pair.human.authorId !== request.botUserId && pair.human.author?.kind !== "bot" && pair.bot.replyToAuthorId === pair.human.authorId && pair.human.timestampMs < pair.bot.timestampMs)
    .sort((a, b) => b.score - a.score || b.bot.timestampMs - a.bot.timestampMs);
  const capacity = Math.max(1, Math.floor(count));
  // At most two complete exchange pairs precede the ordinary tail. Do not
  // retain half a pair as though its recipient proof had been preserved.
  const pairBudget = Math.min(2, Math.floor(Math.max(0, capacity - required.size) / 2));
  for (const pair of pairs.slice(0, pairBudget)) { required.set(pair.human.messageId, pair.human); required.set(pair.bot.messageId, pair.bot); }
  const selected = new Map([...required].slice(0, capacity));
  for (const event of [...pool].reverse()) if (selected.size < capacity) selected.set(event.messageId, event);
  return { events: [...selected.values()].sort((a, b) => a.timestampMs - b.timestampMs),
    coverage: { available: pool.length, selected: selected.size, required: required.size, omittedRequired: Math.max(0, required.size - selected.size) } };
}
