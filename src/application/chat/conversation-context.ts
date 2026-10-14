import type { ChatRequest, ChatUser } from "./chat-provider.js";

// Metadata stays structured and free text cannot close prompt sections.
export function contextData(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

export function renderConversationRelationships(request: ChatRequest): string {
  const people = new Map<string, ChatUser>();
  const add = (user: ChatUser): void => {
    const prior = people.get(user.id);
    // Keep account IDs separate even when every display label collides.
    people.set(user.id, prior ? { ...user, ...prior } : user);
  };
  add(request.currentUser);
  request.mentionedUsers.forEach(add);
  const selected = [...request.replyChain, ...request.channelHistory];
  selected.forEach((message) => add(message.author ?? {
    id: message.authorId, displayName: message.authorDisplayName, roleNames: [],
  }));
  const events = [...new Map(selected.map((message) => [message.messageId, {
    messageId: message.messageId, authorId: message.authorId, timestampMs: message.timestampMs,
    observedAuthorLabel: message.authorDisplayName,
    channelId: message.channelId ?? request.channelId,
    replyToMessageId: message.replyToMessageId ?? null,
    replyTargetStatus: message.replyToMessageId
      ? selected.some((target) => target.messageId === message.replyToMessageId) ? "selected" : "unresolved"
      : "none",
  }])).values()];
  const event = request.currentEvent ?? null;
  return contextData({
    participants: [...people.values()].map((user) => ({
      id: user.id, displayName: user.displayName, username: user.username ?? null,
      globalName: user.globalName ?? null, guildNickname: user.guildNickname ?? null,
      kind: user.kind ?? (user.id === request.botUserId ? "bot" : "unknown"),
      namesObservedForThisContext: true,
    })),
    messages: events,
    currentEvent: event,
    currentSpeakerId: event?.type === "reaction_snapshot" ? null : event?.authorId ?? request.currentUser.id,
    omittedTarget: event?.type === "message" && event.replyToMessageId && !selected.some((message) => message.messageId === event.replyToMessageId)
      ? { messageId: event.replyToMessageId, status: "unresolved" } : null,
  });
}
