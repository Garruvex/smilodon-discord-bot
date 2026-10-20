import { randomBytes } from "node:crypto";
import { retryAfterMs } from "../../../application/concurrency/retry-after.js";
import { chatDeliveryText } from "../../../application/i18n/chat-delivery.js";
import type { GuardedConversationContext, GuardedContextPort, GuardedContextSource } from "../../../application/chat/guarded-conversation-context.js";
import { bindProvenanceOutput, type ContextProvenance } from "../../../application/chat/context-provenance.js";
import type { Attachment, Message, User, GuildMember } from "discord.js";
import type { ChatUser, ConversationEvent } from "../../../application/chat/chat-provider.js";
import type { Logger } from "pino";
import { withDiscordCaller } from "../../../application/diagnostics/discord-diagnostics.js";
import { eligibilityReason, emitChatDiagnostic, safeFailure } from "../../../application/diagnostics/chat-diagnostics.js";
import { collectEligibleHistory, channelHistoryPolicy } from "../../../application/chat/eligible-channel-history.js";
import type { SocialChatEligibility, SocialTrigger, HistoricalOriginBudget } from "./social-chat-eligibility.js";
import { SocialOutputSuppressed, type MessageOriginStore, type MessageOrigin } from "../../../application/chat/message-origin-store.js";

import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import type { ChannelHistoryMessage, ChatImage, ChatSource, GeneratedChatImage } from "../../../application/chat/chat-provider.js";
import { planChatDelivery } from "../../../application/chat/chat-message-chunker.js";
import { planImageDelivery } from "../../../application/chat/chat-image-delivery.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { PlaybackActor } from "../../../application/music/playback-service.js";
import { createPlaybackActorFromMember } from "../commands/music/music-command-support.js";

const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const allowedDiscordImageHosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const maximumImageBytes = 8 * 1024 * 1024;

export interface ChatDeliveryPayload {
  // Reuse for every create attempt of this part. Message edits omit these.
  nonce: string;
  enforceNonce: true;
  content: string;
  files: readonly { attachment: Buffer; name: string }[];
}

export interface ChatDeliverySender {
  // Sends the very first message of the reply — usually message.reply(...),
  // or editing an existing "thinking…"/image-generation-preview placeholder.
  // A failure propagates after bounded retries; a transport failure can leave
  // acceptance unknown. Every create attempt must forward the supplied nonce.
  first(payload: ChatDeliveryPayload): Promise<Message>;
  // Sends every subsequent message — usually message.channel.send(...). A
  // failure here (after retries) is handled internally by
  // deliverChatResponse: it stops sending further messages and posts a
  // short partial-delivery notice instead of throwing, since some of the
  // reply already reached the channel and a generic top-level error would
  // be misleading at that point.
  rest(payload: ChatDeliveryPayload): Promise<Message>;
}

const deliveryRetryAttempts = 3;
const deliveryRetryDelayMs = 500;

async function sendWithRetry<T>(send: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= deliveryRetryAttempts; attempt++) {
    if (attempt > 1 && Date.now() - started >= 60_000) throw lastError;
    try {
      return await send();
    } catch (error) {
      if (error instanceof SocialOutputSuppressed) throw error;
      const status = safeFailure(error, "operation_error").httpStatus;
      if (retryAfterMs(error) !== null || status === 429 || status !== undefined && status >= 400 && status < 500 && status !== 408 || Date.now() - started >= 60_000) throw error;
      lastError = error;
      if (attempt < deliveryRetryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, deliveryRetryDelayMs * attempt));
      }
    }
  }
  throw lastError;
}

// Reply-chain resolution, image selection/loading, and reply formatting used
// by both a direct-mention/reply turn and an ambient (name-mention) turn —
// extracted from MentionChatBehavior so the two triggers share the exact
// same tuned logic instead of forking it.
export class ChatTurnSupport {
  public constructor(
    private readonly logger: Logger,
    private readonly eligibility: SocialChatEligibility | null = null,
    private readonly origins: MessageOriginStore | null = null,
    private readonly onUtilitySource: ((message: Message) => void) | null = null,
  ) {}

  public toChatUser(user: User, member: GuildMember | null = null): ChatUser {
    return {
      id: user.id, username: user.username, globalName: user.globalName ?? null,
      guildNickname: member?.nickname ?? null, kind: user.bot ? "bot" : "human",
      displayName: member?.displayName ?? user.displayName ?? user.username,
      roleNames: [...(member?.roles?.cache.values() ?? [])].filter((role) => role.id !== member?.guild?.id)
        .map((role) => role.name.slice(0, 50)).slice(0, 10),
    };
  }

  public toMessageEvent(message: Message): ConversationEvent {
    return {
      type: "message", messageId: message.id, channelId: message.channelId,
      timestampMs: message.createdTimestamp, authorId: message.author.id,
      replyToMessageId: message.reference?.messageId ?? null,
      mentionedUserIds: [...message.mentions.users.keys()].filter((id) => id !== message.client.user?.id),
    };
  }

  public createContextPort(source: Message, reaction = false): GuardedContextPort {
    const eligibility = this.eligibility;
    const version = eligibility?.contextPolicyVersion(source);
    const passes = new WeakMap<AbortSignal, { messages: Map<string, Message>; members: Map<string, Promise<GuildMember | null>> }>();
    const state = (signal: AbortSignal): { messages: Map<string, Message>; members: Map<string, Promise<GuildMember | null>> } => {
      let value = passes.get(signal); if (!value) { value = { messages: new Map(), members: new Map() }; passes.set(signal, value); } return value;
    };
    const member = async (id: string, signal: AbortSignal): Promise<GuildMember | null> => {
      if (signal.aborted) return null;
      const cache = state(signal).members;
      if (!cache.has(id)) cache.set(id, source.guild?.members.fetch({ user: id, force: true }).catch(() => null) ?? Promise.resolve(null));
      return cache.get(id)!;
    };
    return {
      guildId: source.guildId!, channelId: source.channelId, sourceMessageId: source.id, actorId: reaction ? null : source.author.id, persist: eligibility?.canPersistContext(source) ?? false,
      coverage: (report) => emitChatDiagnostic(this.logger, { event: "context.guard.coverage", ...report }),
      work: (phase, status, durationMs) => emitChatDiagnostic(this.logger, { event: "context.guard.work", phase, status, durationMs }),
      validation: (status, reads) => emitChatDiagnostic(this.logger, { event: "context.guard.validation", status, reads }),
      policyCurrent: () => !!eligibility && eligibility.contextPolicyVersion(source) === version,
      prepareValidation: async (ids, signal): Promise<void> => {
        if (!eligibility || signal.aborted || !ids.length) return;
        if (!await eligibility.canReadHistory(source, source.author.bot ? null : await member(source.author.id, signal))) return;
        // One fresh REST page replaces up to 100 individual message reads.
        // Anchor at the newest dependency so newer chat cannot displace it.
        // Older/unreturned dependencies still require a fresh individual read;
        // absence from a page is never proof of deletion or authorization.
        const snowflakes = ids.filter((id) => /^\d{1,20}$/u.test(id)).map((id) => BigInt(id));
        if (!snowflakes.length || signal.aborted) return;
        const newest = snowflakes.reduce((a, b) => a > b ? a : b);
        const fetched = await source.channel.messages.fetch({ limit: 100, before: String(newest + 1n), cache: false });
        if (signal.aborted) return;
        for (const message of fetched.values()) {
          if (message.guildId === source.guildId && message.channelId === source.channelId) state(signal).messages.set(message.id, message);
        }
      },
      read: async (id, signal): Promise<GuardedContextSource | null> => {
        if (!eligibility || signal.aborted) return null;
        const messages = state(signal).messages;
        const message = messages.get(id) ?? await source.channel.messages.fetch({ message: id, force: true }).catch(() => null);
        if (!message || signal.aborted || message.guildId !== source.guildId || message.channelId !== source.channelId) return null;
        messages.set(id, message);
        if (message.author.bot && message.author.id !== source.client.user?.id) return null;
        const actor = message.author.bot ? null : await member(message.author.id, signal);
        const access = await eligibility.checkGuardedSource(message, actor, id === source.id);
        if (!access.eligible) {
          const reason = eligibilityReason.safeParse(access.reason);
          if (reason.success) emitChatDiagnostic(this.logger, { event: "context.eligibility.denied", sourceMessageId: id, purpose: "guarded_current", reason: reason.data });
          return null;
        }
        const origin = message.author.bot ? await this.origins?.find(source.guildId!, source.channelId, id).catch(() => null) : null;
        if (message.author.bot && origin?.origin !== "chat") return null;
        const user = this.toChatUser(message.author, actor);
        const event = { ...this.toChannelHistoryMessages([message])[0]!, author: { ...user, roleNames: [...user.roleNames].sort() }, content: message.content, imageCount: 0, replyToAuthorId: null, replyToAuthorDisplayName: null };
        return { event, origin: message.author.bot ? "chat" : "human", provenance: origin?.contextProvenance ?? null };
      },
      page: async (before, signal): Promise<readonly string[]> => {
        if (!eligibility || signal.aborted || !await eligibility.canReadHistory(source, source.author.bot ? null : await member(source.author.id, signal))) return [];
        const fetched = await source.channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (signal.aborted) return [];
        for (const message of fetched.values()) state(signal).messages.set(message.id, message);
        return [...fetched.keys()];
      },
      actor: async (id, signal): Promise<ChatUser | null> => {
        const actor = await member(id, signal); if (!actor || actor.user.bot || !eligibility) return null;
        // Use the same author rule without importing any of the member's messages.
        const allowed = await eligibility.checkGuardedActor(source, actor);
        return allowed ? this.toChatUser(actor.user, actor) : null;
      },
    };
  }

  public createHistoricalContextRefresh(source: Message): (events: readonly ChannelHistoryMessage[]) => Promise<ChannelHistoryMessage[]> {
    const budget: HistoricalOriginBudget = { remaining: channelHistoryPolicy.maxOriginFetches, resolved: new Map() };
    let remainingMessages: number = channelHistoryPolicy.maxRevalidationMessages;
    let remainingPasses: number = channelHistoryPolicy.maxRevalidationPasses;
    return async (events) => {
      if (--remainingPasses < 0 || events.length > remainingMessages) {
        emitChatDiagnostic(this.logger, { event: "context.history.revalidated", requested: events.length, selected: 0, status: "budget_exhausted" });
        return [];
      }
      remainingMessages -= events.length;
      budget.resolved.clear();
      const selected = await this.refreshHistoricalContext(source, events, budget);
      emitChatDiagnostic(this.logger, { event: "context.history.revalidated", requested: events.length, selected: selected.length,
        status: selected.length === events.length ? "refreshed" : "underfilled" });
      return selected;
    };
  }

  private async refreshHistoricalContext(source: Message, events: readonly ChannelHistoryMessage[], budget: HistoricalOriginBudget): Promise<ChannelHistoryMessage[]> {
    if (!this.eligibility || !await this.eligibility.canReadHistory(source)) return [];
    const selected: Message[] = [];
    for (const event of events) {
      if (event.channelId !== source.channelId || event.author?.kind === "bot") continue;
      const message = await source.channel.messages.fetch({ message: event.messageId, force: true }).catch(() => null);
      if (!message || message.channelId !== source.channelId || message.guildId !== source.guildId || message.author.bot) continue;
      if ((await this.eligibility.check(message, "history", budget)).eligible) selected.push(message);
    }
    return this.toChannelHistoryMessages(selected);
  }

  public async refreshHistoryEvent(source: Message, event: ChannelHistoryMessage): Promise<ChannelHistoryMessage | null> {
    if (event.channelId && event.channelId !== source.channelId || !await this.isEligible(source, "observation")) return null;
    const message = await source.channel.messages.fetch(event.messageId).catch(() => null);
    return message && await this.isEligible(message, "observation") ? this.toChannelHistoryMessages([message])[0]! : null;
  }

  public async isEligible(message: Message, trigger: SocialTrigger = "direct"): Promise<boolean> {
    if (!this.eligibility) return true;
    const result = await this.eligibility.check(message, trigger);
    const reason = eligibilityReason.safeParse(result.reason);
    if (!result.eligible && reason.success) emitChatDiagnostic(this.logger, { event: "context.eligibility.denied",
      sourceMessageId: message.id, purpose: trigger, reason: reason.data });
    return result.eligible;
  }

  public async assertEligible(message: Message, trigger: SocialTrigger = "direct"): Promise<void> {
    if (!await this.isEligible(message, trigger)) throw new SocialOutputSuppressed();
  }

  // Null unless the guild has music enabled and the message has a
  // resolvable GuildMember — those two facts can't change mid-turn, so
  // they're resolved once here. The role gate itself (musicController /
  // botAdministrator) is deliberately NOT checked here: it's rechecked by
  // each music tool on every call against this same live `member` (whose
  // `.roles.cache` reflects role changes as they happen), rather than
  // trusting a single check made before the LLM call — mirrors
  // musicPlaybackAccessPolicy's role gate, since tool calls bypass the
  // normal command access-policy pipeline entirely. Actual voice-channel
  // presence/match is still enforced by PlaybackService.
  public resolveMusicActor(
    message: Message,
    profile: GuildConfiguration,
  ): {
    actor: PlaybackActor;
    resolveAccessSubjectFields: () => {
      roleIds: readonly string[];
      memberPermissions: bigint;
      botPermissions: bigint | null;
    };
    volumeMaximum: number;
    musicControllerRoleIds: ReadonlySet<string>;
    botAdministratorRoleIds: ReadonlySet<string>;
  } | null {
    if (!profile.features.music || !message.inGuild() || !message.member) return null;
    // Bind the player's text channel to the same channel the control panel's
    // own plain-text song requests use (ControlChannelService.handleMessage),
    // not wherever this chat message happened to be posted — otherwise a
    // player started via ambient/mention chat ends up bound to an arbitrary
    // channel instead of the one the panel and its "up next"/now-playing
    // state are anchored to.
    const musicTextChannelId = profile.channels.controlPanel ?? message.channelId;
    const member = message.member;
    return {
      // bypassVoiceChannelCheck/allowQueueWithoutVoiceChannel are placeholders
      // here — both false, the safe default — because DJ-mode/open-queue
      // eligibility depend on live role/guild-config state, just like the
      // role gate below. Every music tool call re-derives the real values
      // from evaluateMusicToolAccess's fresh decision right before it
      // touches PlaybackService (see e.g. pause-command.ts's executeAsTool),
      // rather than trusting this turn-start snapshot.
      actor: createPlaybackActorFromMember(message.guildId, musicTextChannelId, member, false, false),
      // Closes over the live `member` so each tool call (see
      // ChatToolContext.music's own comment) reads current roles/permissions
      // at call time — this can span multiple LLM round-trips within one
      // turn, during which the member's roles can change.
      resolveAccessSubjectFields: () => ({
        roleIds: [...member.roles.cache.keys()],
        memberPermissions: member.permissions.bitfield,
        botPermissions: member.guild.members.me?.permissions.bitfield ?? null,
      }),
      volumeMaximum: profile.music.maximumVolume,
      musicControllerRoleIds: profile.roles.musicController,
      botAdministratorRoleIds: profile.roles.botAdministrator,
    };
  }

  // Walks up the reply chain from `message`, bounded by both a depth cap and
  // a char budget (whichever hits first stops the walk) so a deep or
  // verbose chain can't blow up prompt size. Returns ancestors oldest-first,
  // ending just before `message`. A broken link (deleted/inaccessible
  // message) stops the walk cleanly rather than throwing.
  public async resolveReplyChain(message: Message): Promise<{ kept: Message[]; overflow: Message[] }> {
    const kept: Message[] = [];
    let fetched = 0;
    let status: "complete" | "fetch_failed" | "ineligible" | "bounded" = "complete";
    let current: Message = message;
    let remainingChars = chatMemoryLimits.maxReplyChainChars;
    for (let depth = 0; depth < chatMemoryLimits.maxReplyChainDepth; depth++) {
      const referenceId = current.reference?.messageId;
      if (!referenceId) break;
      const parent = await current.channel.messages.fetch(referenceId).catch(() => null);
      if (!parent) { status = "fetch_failed"; break; }
      fetched++;
      if (!await this.isEligible(parent, "direct")) { status = "ineligible"; break; }
      const contentLength = Math.min(parent.content.length, chatMemoryLimits.maxUserMessageChars);
      // Always keep at least the immediate parent even if it alone exceeds
      // the budget; only stop *extending further* once the next hop won't fit.
      if (kept.length > 0 && contentLength > remainingChars) break;
      remainingChars -= contentLength;
      kept.push(parent);
      current = parent;
    }
    // `current` is now the oldest hop actually kept. If it's still a reply
    // itself, the thread genuinely continues further back than the kept
    // window reaches (depth cap or char budget stopped us, not a broken
    // link or the real start of the thread) — walk further, bounded more
    // loosely, purely as raw input for an on-demand overflow summary. This
    // never fetches anything when the whole thread already fit in `kept`
    // (the very next reference-id check fails immediately, no request
    // made), so a normal shallow reply chain pays nothing extra.
    const overflow: Message[] = [];
    let overflowChars = chatMemoryLimits.maxReplyChainOverflowChars;
    for (let depth = 0; depth < chatMemoryLimits.maxReplyChainOverflowDepth; depth++) {
      const referenceId = current.reference?.messageId;
      if (!referenceId) break;
      const parent = await current.channel.messages.fetch(referenceId).catch(() => null);
      if (!parent) { status = "fetch_failed"; break; }
      fetched++;
      if (!await this.isEligible(parent, "direct")) { status = "ineligible"; break; }
      const contentLength = Math.min(parent.content.length, chatMemoryLimits.maxUserMessageChars);
      if (overflow.length > 0 && contentLength > overflowChars) break;
      overflowChars -= contentLength;
      overflow.push(parent);
      current = parent;
    }
    if (status === "complete" && current.reference?.messageId) status = "bounded";
    emitChatDiagnostic(this.logger, { event: "context.source.selected", source: "reply_chain", fetched,
      selected: kept.length + overflow.length, omitted: Math.max(0, fetched - kept.length - overflow.length), status,
      chars: [...kept, ...overflow].reduce((total, item) => total + item.content.length, 0) });
    return { kept: kept.reverse(), overflow: overflow.reverse() };
  }

  // Fetches the last `limit` messages in the channel before `message`, from
  // anyone — not reply-linked, unlike resolveReplyChain. `excludeIds` is the
  // set of message IDs already covered by the resolved reply chain, so a
  // message that's both "recently posted" and "an ancestor you replied to"
  // doesn't show up under two different context sections. Bounded by a char
  // budget the same way resolveReplyChain is; a fetch failure returns an
  // empty list rather than throwing, since this is best-effort ambient
  // context, not something the turn should fail over.
  // `before` anchors the fetch window — defaults to `message.id`, i.e. "the
  // channel leading up to `message`" (right for a live mention/ambient
  // turn, where `message` IS the current moment). Pass `null` explicitly to
  // fetch the most recent channel messages instead, with no cutoff — the
  // right anchor for a turn evaluated well after `message` was sent (e.g.
  // ReactionReplyScheduler, evaluated minutes after its own prior reply),
  // where "before message.id" would silently miss everything that happened
  // in between.
  public async resolveChannelHistory(
    message: Message,
    limit: number,
    excludeIds: ReadonlySet<string>,
    before: string | null = message.id,
    maxChars: number = chatMemoryLimits.maxChannelHistoryChars,
    countFirst = false,
  ): Promise<Message[]> {
    if (countFirst) {
      if (!this.eligibility || !await this.eligibility.canReadHistory(message)) {
        emitChatDiagnostic(this.logger, { event: "context.history.coverage", requested: limit, fetched: 0, examined: 0, eligible: 0, pages: 0,
          selectedIds: [], status: "ineligible", omissions: { excluded: 0, ineligible: 0, unverifiable_bot: 0, duplicate: 0 } });
        return [];
      }
      const budget: HistoricalOriginBudget = { remaining: channelHistoryPolicy.maxOriginFetches, resolved: new Map() };
      const result = await collectEligibleHistory({ requested: limit, before, excludeIds,
        fetchPage: async (cursor, pageSize) => [...(await message.channel.messages.fetch({ limit: pageSize, ...(cursor ? { before: cursor } : {}) })).values()],
        authorize: async (candidate) => {
          if (candidate.channelId !== message.channelId || candidate.guildId !== message.guildId) return "ineligible";
          if (candidate.author.bot) return "unverifiable_bot";
          if (!this.eligibility) return "ineligible";
          const result = await this.eligibility.check(candidate, "history", budget);
          if (!result.eligible) {
            const reason = eligibilityReason.safeParse(result.reason);
            if (reason.success) emitChatDiagnostic(this.logger, { event: "context.eligibility.denied", sourceMessageId: candidate.id, purpose: "history", reason: reason.data });
          }
          return result.eligible ? null : "ineligible";
        },
      });
      emitChatDiagnostic(this.logger, { event: "context.history.coverage", ...result.coverage });
      return result.messages;
    }
    if (!await this.isEligible(message, "observation")) {
      emitChatDiagnostic(this.logger, { event: "context.source.selected", source: "channel_history", fetched: 0, selected: 0, omitted: 0, chars: 0, status: "ineligible" });
      return [];
    }
    // Oversample the raw fetch (Discord's own per-request cap is 100, so
    // this never costs an extra round trip) — a flat "last `limit` from
    // anyone" fetch lets our own replies, which appear after nearly every
    // human turn in a busy channel, eat half or more of a small window,
    // leaving too few distinct human messages for the model to reliably
    // track who said what across several people talking at once.
    const fetchLimit = Math.min(limit * 4, 100);
    const fetched = await message.channel.messages.fetch({
      limit: fetchLimit,
      ...(before ? { before } : {}),
    }).catch(() => null);
    if (!fetched) {
      emitChatDiagnostic(this.logger, { event: "context.source.selected", source: "channel_history", fetched: 0, selected: 0, omitted: 0, chars: 0, status: "fetch_failed" });
      return [];
    }
    const selfId = message.client.user?.id ?? null;
    // Budgeted separately from human messages: our own recent replies are
    // still valuable context (a human often reacts to what we just said),
    // so they're not dropped outright — just capped at half the human
    // budget so they can never crowd human speakers out of the window
    // entirely. A third-party bot (e.g. a leveling bot) gets neither
    // budget — noise, not conversational context.
    const humanBudget = limit;
    const selfBudget = Math.max(1, Math.ceil(limit / 2));
    let humanKept = 0;
    let selfKept = 0;
    let remainingChars = maxChars;
    const kept: Message[] = [];
    // Discord returns newest-first; walk nearest-to-current first so
    // recency wins once a budget is hit, then reverse for oldest-first
    // display (matching resolveReplyChain's convention).
    for (const candidate of fetched.values()) {
      if (excludeIds.has(candidate.id)) continue;
      if (!await this.isEligible(candidate, "observation")) continue;
      if (candidate.author.bot && candidate.author.id !== selfId) continue;
      const isSelf = candidate.author.id === selfId;
      if (isSelf ? selfKept >= selfBudget : humanKept >= humanBudget) continue;
      const contentLength = Math.min(candidate.content.length, chatMemoryLimits.maxUserMessageChars);
      if (kept.length > 0 && contentLength > remainingChars) break;
      remainingChars -= contentLength;
      kept.push(candidate);
      if (isSelf) selfKept++; else humanKept++;
      if (humanKept >= humanBudget && selfKept >= selfBudget) break;
    }
    emitChatDiagnostic(this.logger, { event: "context.source.selected", source: "channel_history", fetched: fetched.size,
      selected: kept.length, omitted: fetched.size - kept.length, chars: kept.reduce((total, item) => total + item.content.length, 0),
      status: kept.length < fetched.size || fetched.size === fetchLimit ? "bounded" : "complete" });
    return kept.reverse();
  }

  // Preserve not only who wrote each ambient-history message, but also who
  // it was replying to. A bot reply's authorId is always the bot, so without
  // the target the model can easily attach that reply to the wrong nearby
  // human in a busy channel. Discord populates the message cache from the
  // history fetch above; falling back to the selected window also keeps this
  // deterministic in tests and in partial-cache situations.
  public toChannelHistoryMessages(messages: readonly Message[]): ChannelHistoryMessage[] {
    const selectedById = new Map(messages.map((message) => [message.id, message]));
    return messages.map((message) => {
      const referenceId = message.reference?.messageId;
      const target = referenceId
        ? selectedById.get(referenceId)
        : undefined;
      return {
        author: this.toChatUser(message.author, message.member),
        channelId: message.channelId,
        messageId: message.id,
        timestampMs: message.createdTimestamp,
        authorId: message.author.id,
        authorDisplayName: message.member?.displayName ?? message.author.displayName,
        content: message.content.slice(0, chatMemoryLimits.maxUserMessageChars),
        imageCount: [...message.attachments.values()].filter((attachment) =>
          attachment.contentType?.startsWith("image/"),
        ).length,
        hasReplyReference: Boolean(referenceId),
        replyToAuthorId: target?.author.id ?? (referenceId ? message.mentions?.repliedUser?.id : null) ?? null,
        replyToAuthorDisplayName: target
          ? target.member?.displayName ?? target.author.displayName
          : referenceId ? message.mentions?.repliedUser?.displayName ?? null : null,
        replyToMessageId: referenceId ?? null,
      };
    });
  }

  public selectImageAttachments(
    current: readonly Attachment[],
    // Reply-chain attachments grouped by hop, nearest-to-current hop first.
    chainNearestFirst: readonly (readonly Attachment[])[],
    limit: number,
  ): {
    selected: Array<{ attachment: Attachment; source: ChatImage["source"]; sourceIndex: number }>;
    droppedUnsupported: number;
    droppedOverLimit: number;
  } {
    const isImageLike = (attachment: Attachment): boolean => Boolean(attachment.contentType?.startsWith("image/"));
    const chainImageLike = chainNearestFirst.flatMap((attachments) => attachments.filter(isImageLike));
    const currentImageLike = current.filter(isImageLike);
    const supportedCurrent = currentImageLike.filter((attachment) => this.isSupportedImageAttachment(attachment));
    const supportedChain = chainImageLike.filter((attachment) => this.isSupportedImageAttachment(attachment));
    const droppedUnsupportedAttachments = [
      ...currentImageLike.filter((attachment) => !this.isSupportedImageAttachment(attachment)),
      ...chainImageLike.filter((attachment) => !this.isSupportedImageAttachment(attachment)),
    ];
    if (droppedUnsupportedAttachments.length > 0) {
      this.logger.warn(
        {
          droppedCount: droppedUnsupportedAttachments.length,
        },
        "Dropped image attachment(s): unsupported content type or size",
      );
    }
    const droppedUnsupported = droppedUnsupportedAttachments.length;
    // Current message first, then chain images nearest-to-current first, so
    // recency wins once truncated to the limit — the cap is a hard total
    // across both sources combined, not per-source or per-hop.
    const candidates: Array<{ attachment: Attachment; source: ChatImage["source"] }> = [
      ...supportedCurrent.map((attachment) => ({ attachment, source: "current_message" as const })),
      ...supportedChain.map((attachment) => ({ attachment, source: "reply_chain" as const })),
    ];
    const selected = candidates.slice(0, limit).map((item, sourceIndex) => ({ ...item, sourceIndex }));
    const droppedOverLimit = Math.max(0, candidates.length - limit);
    return { selected, droppedUnsupported, droppedOverLimit };
  }

  private normalizeContentType(contentType: string | null): string | null {
    return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  }

  private isSupportedImageAttachment(attachment: Attachment): boolean {
    const contentType = this.normalizeContentType(attachment.contentType);
    return Boolean(
      contentType &&
      supportedImageTypes.has(contentType) &&
      attachment.size > 0 &&
      attachment.size <= maximumImageBytes,
    );
  }

  public async loadImages(
    attachments: readonly { attachment: Attachment; source: ChatImage["source"]; sourceIndex: number }[],
  ): Promise<{ images: ChatImage[]; droppedFailed: number }> {
    const images: ChatImage[] = [];
    let droppedFailed = 0;
    for (const { attachment, source, sourceIndex } of attachments) {
      const dataUrl = await this.loadImageDataUrl(attachment);
      if (dataUrl) {
        images.push({ dataUrl, source, sourceIndex });
      } else {
        droppedFailed += 1;
      }
    }
    return { images, droppedFailed };
  }

  private async loadImageDataUrl(attachment: Attachment): Promise<string | null> {
    const contentType = this.normalizeContentType(attachment.contentType);
    if (!contentType || !supportedImageTypes.has(contentType)) return null;
    if (attachment.size <= 0 || attachment.size > maximumImageBytes) return null;
    const url = new URL(attachment.url);
    if (url.protocol !== "https:" || !allowedDiscordImageHosts.has(url.hostname)) {
      this.logger.warn(
        { reason: "host_denied" },
        "Dropped image attachment: URL failed host allow-list check",
      );
      return null;
    }
    const response = await fetch(url, {
      headers: { Accept: contentType },
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      this.logger.warn({ ...safeFailure(error, "operation_error") }, "Dropped image attachment: fetch failed");
      return null;
    });
    if (!response) return null;
    if (!response.ok) {
      this.logger.warn(
        { status: response.status },
        "Dropped image attachment: fetch returned a non-OK status",
      );
      return null;
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > maximumImageBytes) {
      this.logger.warn(
        { bytes: data.length },
        "Dropped image attachment: downloaded size out of bounds",
      );
      return null;
    }
    const actualContentType = this.detectImageContentType(data);
    if (!actualContentType) {
      this.logger.warn(
        { reason: "signature_mismatch" },
        "Dropped image attachment: file signature did not match any supported image format",
      );
      return null;
    }
    return `data:${actualContentType};base64,${data.toString("base64")}`;
  }

  private detectImageContentType(data: Buffer): string | null {
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return "image/jpeg";
    }
    if (data.length >= 6) {
      const signature = data.subarray(0, 6).toString("ascii");
      if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
    }
    if (
      data.length >= 12 &&
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    return null;
  }

  // Delivers one chat reply as a bounded sequence of Discord messages —
  // splitting at paragraph/code-fence-safe boundaries (see
  // chat-message-chunker.ts) rather than the destructive single-message
  // truncation this replaced, falling back to a .txt attachment for replies
  // too long to chunk at all. Generated images are packed into their own
  // aggregate-byte-bounded groups (chat-image-delivery.ts) and appended to
  // the tail of the message sequence; any image too large to ever deliver
  // is reported rather than silently dropped. A mid-sequence Discord send
  // failure (after retries) stops further sends and posts a short notice
  // instead of the caller's generic top-level error, so a partially
  // delivered reply is never followed by a misleading "that failed" message.
  public async deliverChatResponse(params: {
    sender: ChatDeliverySender;
    text: string;
    sources: readonly ChatSource[];
    images: readonly GeneratedChatImage[];
    emptyFallbackContent: string;
    partialDeliveryNotice?: string;
    maxImageAggregateBytes: number;
    sourceMessage?: Message;
    trigger?: SocialTrigger;
    origin?: MessageOrigin;
    contextProvenance?: ContextProvenance | null;
    contextLease?: GuardedConversationContext;
    characterMessages?: readonly string[] | undefined;
    characterDelayMs?: number | undefined;
    characterIsCurrent?: (() => boolean) | undefined;
    characterCanDeliver?: (() => Promise<boolean>) | undefined;
    recordDelivery?: ((message: Message) => void) | undefined;
  }): Promise<{ deliveredText: string; firstMessageId: string }> {
    const plan = planChatDelivery(params.text, params.sources);
    const imagePlan = planImageDelivery(params.images, params.maxImageAggregateBytes);

    const sends: { content: string; files: { attachment: Buffer; name: string }[] }[] = params.characterMessages?.length && params.characterMessages.every((content) => content.length <= 2000) && params.sources.length === 0 && params.images.length === 0
      ? params.characterMessages.map((content) => ({ content, files: [] })) : plan.mode === "attachment"
      ? [{
          content: plan.note,
          files: [{ attachment: Buffer.from(plan.attachmentText, "utf8"), name: plan.attachmentFilename }],
        }]
      : plan.chunks.map((chunk) => ({ content: chunk, files: [] }));

    // The first image group rides along with the last already-planned
    // message (so a short reply plus one small image doesn't need an extra
    // message of its own); any further groups become their own image-only
    // messages, each within the aggregate byte cap.
    const [firstImageGroup, ...restImageGroups] = imagePlan.groups;
    if (firstImageGroup) {
      const attachments = firstImageGroup.map((image) => ({ attachment: image.data, name: image.filename }));
      const lastSend = sends.at(-1);
      if (lastSend) {
        lastSend.files.push(...attachments);
      } else {
        sends.push({ content: params.emptyFallbackContent, files: attachments });
      }
    }
    for (const group of restImageGroups) {
      sends.push({ content: "", files: group.map((image) => ({ attachment: image.data, name: image.filename })) });
    }

    if (imagePlan.undeliverable.length > 0) {
      const count = imagePlan.undeliverable.length;
      const note = `(${count} image${count > 1 ? "s" : ""} couldn't be delivered — too large.)`;
      const lastSend = sends.at(-1);
      if (lastSend && lastSend.content.length + note.length + 2 <= 2_000) {
        lastSend.content = lastSend.content ? `${lastSend.content}\n\n${note}` : note;
      } else {
        sends.push({ content: note, files: [] });
      }
    }

    if (sends.length === 0) {
      sends.push({ content: params.emptyFallbackContent, files: [] });
    } else if (sends[0]!.content.length === 0 && sends[0]!.files.length === 0) {
      sends[0]!.content = params.emptyFallbackContent;
    }

    const payloads: ChatDeliveryPayload[] = sends.map((send) => ({ ...send, nonce: randomBytes(12).toString("hex"), enforceNonce: true }));
    const confirmedText: string[] = [];
    let deliveredParts = 0;
    let partial = false;
    const assertCurrent = async (): Promise<void> => {
      if (params.contextLease && !await params.contextLease.validate()) throw new SocialOutputSuppressed();
      if (params.characterIsCurrent && !params.characterIsCurrent()) throw new SocialOutputSuppressed();
      if (params.characterCanDeliver && !await params.characterCanDeliver()) throw new SocialOutputSuppressed();
      if (params.sourceMessage) await this.assertEligible(params.sourceMessage, params.trigger ?? "direct");
    };
    const sendAndRecord = async (send: () => Promise<Message>, expectedContent: string): Promise<Message> => {
      const sent = await sendWithRetry(async () => { await assertCurrent(); return withDiscordCaller("chat_text", send); });
      deliveredParts++; confirmedText.push(sent.content ?? expectedContent);
      emitChatDiagnostic(this.logger, { event: "chat.delivery.part", deliveredMessageId: sent.id, part: deliveredParts });
      try { params.recordDelivery?.(sent); }
      catch (error) { emitChatDiagnostic(this.logger, { event: "chat.delivery.bookkeeping_failed", stage: "proof", ...safeFailure(error, "operation_error") }); }
      if (this.origins && params.sourceMessage?.guildId) {
        try { await this.origins.record({
          guildId: params.sourceMessage.guildId, channelId: params.sourceMessage.channelId, messageId: sent.id,
          origin: params.origin ?? "chat", sourceMessageId: params.sourceMessage.id, createdAt: Date.now(),
          contextProvenance: params.contextLease ? params.contextLease.provenance(sent.content) : bindProvenanceOutput(params.contextProvenance, sent.content, {
            guildId: params.sourceMessage.guildId, channelId: params.sourceMessage.channelId,
          }),
        }); } catch (error) { emitChatDiagnostic(this.logger, { event: "chat.delivery.bookkeeping_failed", stage: "origin", ...safeFailure(error, "operation_error") }); }
      }
      return sent;
    };
    const [firstSend, ...restSends] = payloads;
    let firstMessage: Message;
    try {
      firstMessage = await sendAndRecord(() => params.sender.first(firstSend!), firstSend!.content);
    } catch (error) {
      emitChatDiagnostic(this.logger, { event: "chat.delivery.completed", plannedParts: sends.length, deliveredParts,
        status: error instanceof SocialOutputSuppressed ? "suppressed" : "failed", ...(error instanceof SocialOutputSuppressed ? {} : safeFailure(error)) });
      throw error;
    }
    for (const send of restSends) {
      try {
        if (params.characterDelayMs) await new Promise((resolve) => setTimeout(resolve, params.characterDelayMs! / Math.max(1, restSends.length)));
        await sendAndRecord(() => params.sender.rest(send), send.content);
      } catch (error) {
        partial = true;
        if (error instanceof SocialOutputSuppressed) break;
        this.logger.warn({ error }, "Chat reply delivery failed partway through a multi-message response");
        const status = safeFailure(error, "operation_error").httpStatus;
        if (retryAfterMs(error) === null && (status === undefined || status >= 500)) {
          try { await assertCurrent(); await withDiscordCaller("chat_text", () => params.sender.rest({
            content: params.partialDeliveryNotice ?? chatDeliveryText.en.partial, files: [], nonce: randomBytes(12).toString("hex"), enforceNonce: true,
          })); } catch { /* A notice cannot cause another delivery attempt. */ }
        }
        break;
      }
    }
    emitChatDiagnostic(this.logger, { event: "chat.delivery.completed", plannedParts: sends.length, deliveredParts, status: partial ? "partial" : "complete" });
    if (params.origin && params.origin !== "chat" && params.sourceMessage && !params.sourceMessage.author.bot) {
      this.eligibility?.markUtilitySource(params.sourceMessage);
      this.onUtilitySource?.(params.sourceMessage);
      await this.origins?.record({ guildId: params.sourceMessage.guildId!, channelId: params.sourceMessage.channelId,
        messageId: params.sourceMessage.id, origin: params.origin, sourceMessageId: null, createdAt: Date.now(),
      }).catch((error: unknown) => this.logger.warn({ error }, "Failed to persist functional interaction origin"));
    }
    return { deliveredText: partial ? confirmedText.join("\n\n") : params.text, firstMessageId: firstMessage.id };
  }

  // Applies the model's spontaneous reactions on OTHER channel messages (see
  // ChatResponse.historyReactions) — each entry is independently fetched and
  // reacted, so one deleted/uncached message or one bad emoji never blocks
  // the rest. Skips a message the bot has already reacted to (regardless of
  // which emoji) so a standout message that keeps reappearing in
  // channel_history across several turns doesn't accumulate duplicate
  // reactions from us.
  public async applyHistoryReactions(
    channel: { messages: { fetch(id: string): Promise<Message> } },
    reactions: readonly { messageId: string; emoji: string }[],
    logContext: Record<string, unknown>,
    reserve?: () => ((success: boolean) => void) | null,
  ): Promise<void> {
    for (const { messageId, emoji } of reactions) {
      try {
        const target = await channel.messages.fetch(messageId);
        if (!await this.isEligible(target, "history_reaction")) continue;
        if (target.author.bot) continue;
        if (target.reactions.cache.some((reaction) => reaction.me)) continue;
        const release = reserve?.();
        if (reserve && !release) continue;
        try { await withDiscordCaller("chat_reaction", () => target.react(emoji)); release?.(true); }
        catch (error) { release?.(false); throw error; }
      } catch (error) {
        this.logger.warn({ ...logContext, messageId, emoji, error }, "Failed to apply a history reaction");
      }
    }
  }
}
