import { addressedElsewhere, isRecipientCorrection, type RecipientAliases } from "./character-decision.js";
import type { ChannelHistoryMessage } from "./chat-provider.js";
import { exchangeIdleMs } from "./exchange-window.js";

export type SimpleKind = "followup" | "joining";
export type FollowupBasis = "linked" | "open_exchange";
export type SimpleExclusion = "recipient_correction" | "addressed_elsewhere";
export type SimpleClassification =
  | { kind: SimpleKind; basis: FollowupBasis | null; anchorMessageId: string | null; excluded?: undefined }
  | { excluded: SimpleExclusion; kind?: undefined; basis?: undefined; anchorMessageId?: undefined };

const maxChainDepth = 24;

// The structural follow-up/joining rule from the simple participation plan.
// It reads only the supplied authorized events and never treats the bot's last
// response to an author as proof of an exchange by itself (unlike exchangeBranch).
export function classifySimpleTurn(input: { events: readonly ChannelHistoryMessage[]; current: ChannelHistoryMessage; botId: string;
  aliases?: readonly RecipientAliases[] | undefined; startedAt: number }): SimpleClassification {
  const { current, botId, startedAt } = input; const aliases = input.aliases ?? [];
  const history = [...new Map(input.events.filter((event) => event.messageId !== current.messageId && event.timestampMs <= current.timestampMs)
    .map((event) => [event.messageId, event])).values()].sort((a, b) => a.timestampMs - b.timestampMs);
  const byId = new Map(history.map((event) => [event.messageId, event]));
  const isBot = (event: ChannelHistoryMessage): boolean => event.authorId === botId;

  // Rule 2: an explicit exclusion, checked before any follow-up basis.
  if (isRecipientCorrection(current.content)) return { excluded: "recipient_correction" };
  if (elsewhere(current, history, byId, botId, aliases)) return { excluded: "addressed_elsewhere" };

  // Rule 3: an explicit reply chain into an exchange holding a confirmed bot reply to this author.
  const visited = new Set<string>(); let cursor = current.replyToMessageId ? byId.get(current.replyToMessageId) : undefined;
  for (let depth = 0; cursor && depth < maxChainDepth && !visited.has(cursor.messageId); depth++) {
    visited.add(cursor.messageId);
    const botReplyToAuthor = isBot(cursor) && cursor.replyToAuthorId === current.authorId;
    const ownMessageBotAnswered = !isBot(cursor) && cursor.authorId === current.authorId &&
      history.some((event) => isBot(event) && event.replyToMessageId === cursor!.messageId && event.replyToAuthorId === cursor!.authorId);
    if (botReplyToAuthor || ownMessageBotAnswered) return { kind: "followup", basis: "linked", anchorMessageId: cursor.messageId };
    cursor = cursor.replyToMessageId ? byId.get(cursor.replyToMessageId) : undefined;
  }

  // Rule 4: the bot's latest message in the channel was addressed to this author, inside
  // the idle window, after this process started, and the author has not turned elsewhere.
  const last = [...history].reverse().find(isBot);
  if (last && last.replyToAuthorId === current.authorId && last.timestampMs >= startedAt &&
      current.timestampMs - last.timestampMs <= exchangeIdleMs &&
      !history.some((event) => event.timestampMs > last.timestampMs && event.authorId === current.authorId &&
        elsewhere(event, history.filter((candidate) => candidate.timestampMs < event.timestampMs), byId, botId, aliases))) {
    return { kind: "followup", basis: "open_exchange", anchorMessageId: last.messageId };
  }
  return { kind: "joining", basis: null, anchorMessageId: null };
}

// An unambiguous address to another human. Replying to one's own message is not one.
function elsewhere(message: ChannelHistoryMessage, history: readonly ChannelHistoryMessage[], byId: ReadonlyMap<string, ChannelHistoryMessage>,
  botId: string, aliases: readonly RecipientAliases[]): boolean {
  const target = message.replyToAuthorId ?? (message.replyToMessageId ? byId.get(message.replyToMessageId)?.authorId : undefined);
  if (target) return target !== botId && target !== message.authorId;
  if (message.replyToMessageId) return false;
  return addressedElsewhere(message, history, botId, aliases, true);
}
