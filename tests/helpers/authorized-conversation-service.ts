import { ChatConversationService, type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatResponse, ChatResponseObserver } from "../../src/application/chat/chat-provider.js";
import { GuardedConfigurationContext } from "../../src/application/context/guarded-configuration-context.js";
import { guardedEvent, guardedFixture } from "./guarded-context-fixture.js";
import { GuardedConversationContext, type GuardedContextSource } from "../../src/application/chat/guarded-conversation-context.js";

// Test-only transport premise: supplied human events are readable in this
// synthetic channel. Stored memories/bot replies receive no invented proof.
export class AuthorizedConversationService extends ChatConversationService {
  private nextSource = 0;
  private readonly sources = new Map<string, GuardedContextSource>();
  private readonly forgotten = new Map<string, number>();
  public override async forgetConversation(guildId: string, userId: string): Promise<void> {
    this.forgotten.set(`${guildId}:${userId}`, Date.now());
    await super.forgetConversation(guildId, userId);
  }
  public override async run(input: ChatConversationInput, deliver: (response: ChatResponse) => Promise<string>, observer?: ChatResponseObserver): Promise<ChatResponse> {
    if (input.guardedContextPort) return super.run(input, deliver, observer);
    const sourceMessageId = input.sourceMessageId ?? `fixture-${++this.nextSource}`;
    const burstCurrent = input.currentBurst?.find((event) => event.messageId === sourceMessageId);
    const timestamp = input.currentEvent?.type === "message" ? input.currentEvent.timestampMs : burstCurrent?.timestampMs ?? Date.now();
    const current = guardedEvent(sourceMessageId, timestamp, burstCurrent?.content ?? input.message, input.currentUser.id, {
      author: input.currentUser, authorDisplayName: input.currentUser.displayName,
      replyToMessageId: input.currentEvent?.type === "message" ? input.currentEvent.replyToMessageId : input.replyChain.at(-1)?.messageId ?? null,
    });
    const fixture = guardedFixture(current, { guildId: input.guildId, channelId: input.channelId });
    for (const [id, source] of this.sources) fixture.sources.set(id, source);
    const read = fixture.port.read;
    fixture.port.read = (id, signal): Promise<GuardedContextSource | null> => this.sources.has(id) ? Promise.resolve(structuredClone(this.sources.get(id)!)) : read(id, signal);
    fixture.actors.set(input.currentUser.id, input.currentUser);
    for (const actor of input.mentionedUsers) fixture.actors.set(actor.id, actor);
    const mode = input.resolveMemoryMode?.() ?? input.channelMemoryModes?.[input.channelId] ?? "shared";
    fixture.port.persist = mode !== "disabled" && mode !== "session_only";
    fixture.port.retention = mode === "session_only" ? "session" : fixture.port.persist ? "durable" : "none";
    fixture.port.shareMemory = true;
    for (const event of [...input.replyChain, ...(input.channelHistoryEnabled === false ? [] : input.channelHistory)]) {
      if (event.timestampMs <= (this.forgotten.get(`${input.guildId}:${event.authorId}`) ?? -Infinity)) continue;
      if (event.author?.kind === "bot" || event.authorId === input.botUserId) continue;
      fixture.add(event);
      fixture.actors.set(event.authorId, event.author ?? { id: event.authorId, displayName: event.authorDisplayName, roleNames: [] });
    }
    // Explicit transport fixtures may declare confirmed exchanges. They must
    // have a real human anchor in the fixture; saved DB rows are never blessed.
    for (const event of [...input.replyChain, ...input.channelHistory]) {
      if (event.authorId !== input.botUserId || !event.replyToMessageId) continue;
      const human = fixture.sources.get(event.replyToMessageId);
      if (!human || human.origin !== "human") continue;
      fixture.port.sourceMessageId = human.event.messageId; fixture.port.actorId = human.event.authorId;
      const origin = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
      fixture.sources.set(event.messageId, { event: { ...event, channelId: input.channelId }, origin: "chat",
        sourceMessageId: human.event.messageId, provenance: origin.provenance(event.content) });
    }
    fixture.port.sourceMessageId = sourceMessageId; fixture.port.actorId = input.currentUser.id;
    const configurationContext = input.configurationContext ?? await GuardedConfigurationContext.open(
      { kind: "persona", guildId: input.guildId, ownerUserId: null },
      { text: input.personality, examples: input.examplePool, loreChunks: input.loreChunks,
        ...(input.personalitySourceHash ? { personalitySourceHash: input.personalitySourceHash } : {}) }, () => true);
    return super.run({ ...input,
      sourceMessageId, guardedContextPort: fixture.port, configurationContext }, async (response) => {
      const text = await deliver(response);
      const proof = response.contextLease?.provenance(text) ?? null;
      const messageId = response.characterDeliveryProof?.[0]?.messageId ?? `${sourceMessageId}-delivered`;
      response.characterDeliveryProof ??= [{ messageId, content: text }];
      this.sources.set(sourceMessageId, fixture.sources.get(sourceMessageId)!);
      this.sources.set(messageId, { event: guardedEvent(messageId, Date.now(), text, input.botUserId ?? "bot", { channelId: input.channelId }),
        origin: "chat", sourceMessageId, provenance: proof });
      fixture.sources.set(messageId, this.sources.get(messageId)!);
      return text;
    }, observer);
  }
}
