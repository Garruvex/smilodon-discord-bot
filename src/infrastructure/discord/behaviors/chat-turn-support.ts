import { randomBytes } from "node:crypto";
import { discordContextSnapshotCurrent } from "../context/discord-context-revision.js";
import { retryAfterMs } from "../../../application/concurrency/retry-after.js";
import { chatDeliveryText } from "../../../application/i18n/chat-delivery.js";
import type { GuardedConversationContext, GuardedContextPort, GuardedContextSource } from "../../../application/chat/guarded-conversation-context.js";
import { registerConversationSource } from "../../../application/context/conversation-source-registry.js";
import { withSessionMessageOrigins, type SessionMessageOriginStore } from "../../../application/chat/session-message-origins.js";
import { guardedAssetsHash, type GuardedAssetDescriptor } from "../../../application/chat/guarded-conversation-context.js";
import { bindProvenanceOutput, type ContextProvenance } from "../../../application/chat/context-provenance.js";
import type { Attachment, Message, User, GuildMember } from "discord.js";
import type { ChatUser, ConversationEvent } from "../../../application/chat/chat-provider.js";
import type { Logger } from "pino";
import { withDiscordCaller } from "../../../application/diagnostics/discord-diagnostics.js";
import { eligibilityReason, emitChatDiagnostic, safeFailure } from "../../../application/diagnostics/chat-diagnostics.js";
import type { SocialChatEligibility, SocialTrigger } from "./social-chat-eligibility.js";
import { SocialOutputSuppressed, type MessageOriginStore, type MessageOrigin, type MessageOriginRecord } from "../../../application/chat/message-origin-store.js";

import { chatMemoryLimits } from "../../../application/chat/chat-memory-policy.js";
import type { ChannelHistoryMessage, ChatSource, GeneratedChatImage } from "../../../application/chat/chat-provider.js";
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
  private readonly origins: SessionMessageOriginStore | null;
  public constructor(
    private readonly logger: Logger,
    private readonly eligibility: SocialChatEligibility | null = null,
    origins: MessageOriginStore | null = null,
    private readonly onUtilitySource: ((message: Message) => void) | null = null,
  ) { this.origins = origins ? withSessionMessageOrigins(origins) : null; }

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
    const dependencies = new Set([source.id]);
    const revisionCurrent = source.client ? discordContextSnapshotCurrent(source.client, source.guildId!, source.channelId, () => dependencies,
      (change, changedMessageId) => emitChatDiagnostic(this.logger, { event: "chat.snapshot.invalidated", gate: "context", change, ...(changedMessageId ? { changedMessageId } : {}) })) : null;
    type Snapshot = { messages: Map<string, Message>; members: Map<string, Promise<GuildMember | null>>; filtered: Map<string, Promise<GuardedContextSource | null>>; forgotten: Map<string, boolean> };
    const makeState = (): Snapshot => ({ messages: new Map(), members: new Map(), filtered: new Map(), forgotten: new Map() });
    const snapshot = makeState();
    if (revisionCurrent) snapshot.messages.set(source.id, source);
    const passes = new WeakMap<AbortSignal, Snapshot>();
    const state = (signal: AbortSignal): Snapshot => {
      if (revisionCurrent) return snapshot;
      let value = passes.get(signal); if (!value) { value = makeState(); passes.set(signal, value); } return value;
    };
    let channelAllowed: Promise<boolean> | null = null;
    let channelScope: Promise<boolean> | null = null;
    const scopeAllowed = (): Promise<boolean> => channelScope ??= eligibility?.canUseContextChannel(source) ?? Promise.resolve(false);
    const readable = (): Promise<boolean> => channelAllowed ??= eligibility?.canReadHistory(source) ?? Promise.resolve(false);
    const member = async (id: string, signal: AbortSignal, required = false): Promise<GuildMember | null> => {
      if (signal.aborted) return null;
      const cache = state(signal).members;
      if (!cache.has(id)) {
        const cached = revisionCurrent ? source.guild?.members.cache?.get(id) ?? (id === source.author.id ? source.member : null) : null;
        const needsRoles = eligibility?.hasContextRoleExclusions(source) ?? true;
        if (!cached && !required && !needsRoles) return null;
        cache.set(id, cached ? Promise.resolve(cached) : !required && !needsRoles ? Promise.resolve(null) :
          source.guild?.members.fetch({ user: id, ...(!revisionCurrent ? { force: true } : {}) }).catch(() => null) ?? Promise.resolve(null));
      }
      return cache.get(id)!;
    };
    const prefilter = async (messages: readonly Message[], signal: AbortSignal): Promise<void> => {
      if (!revisionCurrent || !eligibility || signal.aborted) return;
      const cache = state(signal).forgotten;
      const human = messages.filter((message) => !message.author.bot && message.guildId === source.guildId &&
        message.channelId === source.channelId && !cache.has(message.id));
      const forgotten = await eligibility.sourcesForgotten(human);
      if (!signal.aborted) human.forEach((message, index) => cache.set(message.id, forgotten[index]!));
    };
    const policyCurrent = (): boolean => !!eligibility && eligibility.contextPolicyVersion(source) === version &&
      (!revisionCurrent || revisionCurrent() && eligibility.botCanReadChannel(source, false));
    return registerConversationSource({
      guildId: source.guildId!, channelId: source.channelId, sourceMessageId: source.id, actorId: reaction ? null : source.author.id, persist: eligibility?.canPersistContext(source) ?? false,
      shareMemory: eligibility?.canShareContext(source) ?? false,
      retention: eligibility?.contextRetention(source) ?? "none",
      coverage: (report) => emitChatDiagnostic(this.logger, { event: "context.guard.coverage", ...report }),
      work: (phase, status, durationMs) => emitChatDiagnostic(this.logger, { event: "context.guard.work", phase, status, durationMs }),
      validation: (status, reads, mode) => emitChatDiagnostic(this.logger, { event: "context.guard.validation", status, reads, mode }),
      policyCurrent,
      ...(revisionCurrent ? { snapshotCurrent: async (effect: boolean, signal: AbortSignal, sourceIds: readonly string[]): Promise<boolean> => {
        if (signal.aborted || !policyCurrent()) return false;
        // Collection is done once. At visible effects consult forget tombstones
        // again, including changes made by another process sharing persistence.
        if (effect) {
          const admitted = await Promise.all(sourceIds.map((id) => snapshot.filtered.get(id) ?? Promise.resolve(null)));
          if (admitted.some((item) => !item)) return false;
          const messages = admitted.filter((item) => item?.origin === "human").map((item) => snapshot.messages.get(item!.event.messageId));
          if (messages.some((message) => !message)) return false;
          if ((await eligibility!.sourcesForgotten(messages as Message[])).some(Boolean)) return false;
        }
        return !signal.aborted && policyCurrent();
      } } : {}),
      loadAsset: async (messageId, assetId, signal): Promise<string | null> => {
        if (!eligibility || signal.aborted || !policyCurrent()) return null;
        if (!await scopeAllowed()) return null;
        const message = state(signal).messages.get(messageId) ?? await source.channel.messages.fetch({ message: messageId, force: true }).catch(() => null);
        if (!message || message.guildId !== source.guildId || message.channelId !== source.channelId || signal.aborted) return null;
        const actor = message.author.bot ? null : await member(message.author.id, signal);
        const admitted = state(signal).filtered.get(messageId);
        if (admitted ? !await admitted : !(await eligibility.checkGuardedSource(message, actor, messageId === source.id, await readable(), state(signal).forgotten.get(messageId))).eligible) return null;
        const attachment = message.attachments.get(assetId);
        return attachment && this.isSupportedImageAttachment(attachment) ? this.loadImageDataUrl(attachment, signal) : null;
      },
      prepareValidation: async (ids, signal): Promise<void> => {
        if (!eligibility || signal.aborted || !ids.length) return;
        if (!await readable()) return;
        // Batch dense dependencies, including distant sessions, with at most
        // three fresh pages. Tiny sets use individual reads instead. A page
        // omission still needs an individual read; it never proves deletion.
        let pending = [...new Set(ids.filter((id) => /^\d{1,20}$/u.test(id) && !state(signal).messages.has(id)))].map((id) => BigInt(id)).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
        for (let pages = 0; pending.length >= 4 && pages < 3 && !signal.aborted; pages++) {
          const newest = pending[0]!;
          const fetched = await source.channel.messages.fetch({ limit: 100, before: String(newest + 1n), cache: false });
          if (signal.aborted) return;
          let oldest = newest;
          for (const message of fetched.values()) {
            if (message.guildId !== source.guildId || message.channelId !== source.channelId) continue;
            state(signal).messages.set(message.id, message);
            const id = BigInt(message.id); if (id < oldest) oldest = id;
          }
          await prefilter([...fetched.values()], signal);
          // Do not refetch the same window for deleted/inaccessible IDs.
          pending = pending.filter((id) => id < oldest);
        }
      },
      read: async (id, signal): Promise<GuardedContextSource | null> => {
        const filtered = state(signal).filtered;
        if (filtered.has(id)) return filtered.get(id)!;
        const resolve = async (): Promise<GuardedContextSource | null> => {
          if (!eligibility || signal.aborted || !policyCurrent()) return null;
          if (!await scopeAllowed()) return null;
          if (id !== source.id && !await readable()) return null;
          const messages = state(signal).messages;
          const message = messages.get(id) ?? await source.channel.messages.fetch({ message: id, force: true }).catch(() => null);
          if (!message || signal.aborted || message.guildId !== source.guildId || message.channelId !== source.channelId) return null;
          messages.set(id, message);
          if (message.author.bot && message.author.id !== source.client.user?.id) return null;
          await prefilter([message], signal);
          const actor = message.author.bot ? null : await member(message.author.id, signal);
          const access = await eligibility.checkGuardedSource(message, actor, id === source.id, true, state(signal).forgotten.get(id));
          if (!access.eligible) {
            const reason = eligibilityReason.safeParse(access.reason);
            if (reason.success) emitChatDiagnostic(this.logger, { event: "context.eligibility.denied", sourceMessageId: id, purpose: "guarded_current", reason: reason.data });
            return null;
          }
          dependencies.add(id);
          const origin = message.author.bot ? await this.origins?.find(source.guildId!, source.channelId, id).catch(() => null) : null;
          if (message.author.bot && origin?.origin !== "chat") return null;
          const user = this.toChatUser(message.author, actor);
          const event = { ...this.toChannelHistoryMessages([message])[0]!, author: { ...user, roleNames: [...user.roleNames].sort() }, content: message.content, imageCount: 0, replyToAuthorId: null, replyToAuthorDisplayName: null };
          return { event, sourceMessageId: origin?.sourceMessageId ?? null, assets: this.imageAssetDescriptors(message), origin: message.author.bot ? "chat" : "human", provenance: origin?.contextProvenance ?? null };
        };
        const result = resolve(); filtered.set(id, result); return result;
      },
      page: async (before, signal): Promise<readonly string[]> => {
        if (!eligibility || signal.aborted || !await readable()) return [];
        const fetched = await source.channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (signal.aborted) return [];
        for (const message of fetched.values()) state(signal).messages.set(message.id, message);
        await prefilter([...fetched.values()], signal);
        return [...fetched.keys()];
      },
      actor: async (id, signal): Promise<ChatUser | null> => {
        const actor = await member(id, signal, true); if (!actor || actor.user.bot || !eligibility) return null;
        // Use the same author rule without importing any of the member's messages.
        const allowed = await eligibility.checkGuardedActor(source, actor, await readable());
        return allowed ? this.toChatUser(actor.user, actor) : null;
      },
    });
  }

  public async isEligible(message: Message, trigger: SocialTrigger = "direct"): Promise<boolean> {
    if (!this.eligibility) return true;
    const result = await this.eligibility.check(message, trigger);
    const reason = eligibilityReason.safeParse(result.reason);
    if (!result.eligible && reason.success) emitChatDiagnostic(this.logger, { event: "context.eligibility.denied",
      sourceMessageId: message.id, purpose: trigger, reason: reason.data });
    return result.eligible;
  }

  public createEligibilityCheck(message: Message, trigger: SocialTrigger = "direct"): () => Promise<boolean> {
    const current = message.client ? discordContextSnapshotCurrent(message.client, message.guildId!, message.channelId, () => [message.id],
      (change, changedMessageId) => emitChatDiagnostic(this.logger, { event: "chat.snapshot.invalidated", gate: "trigger", change, ...(changedMessageId ? { changedMessageId } : {}) })) : null;
    const version = this.eligibility?.contextPolicyVersion(message);
    let admission: Promise<boolean> | null = null;
    return async (): Promise<boolean> => {
      if (!current) return this.isEligible(message, trigger);
      const fresh = (): boolean => {
        const reason = !current() ? "discord_revision_changed" : !this.eligibility || this.eligibility.contextPolicyVersion(message) !== version ? "policy_changed" :
          !this.eligibility.botCanReadChannel(message, false) ? "channel_access_changed" : null;
        if (reason) emitChatDiagnostic(this.logger, { event: "chat.guard.rejected", gate: "trigger", reason });
        return reason === null;
      };
      if (!fresh()) return false;
      const allowed = await (admission ??= this.isEligible(message, trigger));
      return allowed && fresh();
    };
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

  private normalizeContentType(contentType: string | null): string | null {
    return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  }

  private imageAssetDescriptors(message: Message): GuardedAssetDescriptor[] {
    return [...(message.attachments?.values() ?? [])].filter((attachment) => this.isSupportedImageAttachment(attachment))
      .map((attachment) => ({ id: attachment.id, contentType: this.normalizeContentType(attachment.contentType)!, size: attachment.size }));
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

  private async loadImageDataUrl(attachment: Attachment, signal?: AbortSignal): Promise<string | null> {
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
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
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
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > maximumImageBytes) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader();
    const chunks: Buffer[] = []; let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array)) { await reader.cancel(); return null; }
          bytes += value.byteLength;
          if (bytes > maximumImageBytes) { await reader.cancel(); return null; }
          chunks.push(Buffer.from(value));
        }
      } catch { return null; } finally { reader.releaseLock(); }
    }
    const data = reader ? Buffer.concat(chunks, bytes) : Buffer.from(await response.arrayBuffer());
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
      if (params.contextLease && params.sourceMessage && (params.contextLease.scope.guildId !== params.sourceMessage.guildId ||
          params.contextLease.scope.channelId !== params.sourceMessage.channelId || params.contextLease.current.messageId !== params.sourceMessage.id)) throw new SocialOutputSuppressed();
      if (params.contextLease && !await params.contextLease.validate("effect")) throw new SocialOutputSuppressed();
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
        try {
          const durableProof = params.contextLease ? params.contextLease.provenance(sent.content) : bindProvenanceOutput(params.contextProvenance, sent.content, {
            guildId: params.sourceMessage.guildId, channelId: params.sourceMessage.channelId,
          });
          const sessionProof = durableProof ? null : params.contextLease?.sessionProvenance(sent.content);
          const proof = durableProof ?? sessionProof ?? null; const assets = this.imageAssetDescriptors(sent);
          const record: MessageOriginRecord = {
          guildId: params.sourceMessage.guildId, channelId: params.sourceMessage.channelId, messageId: sent.id,
          origin: params.origin ?? "chat", sourceMessageId: params.sourceMessage.id, createdAt: Date.now(),
          contextProvenance: (params.origin ?? "chat") === "chat" ? proof && assets.length ? { ...proof, outputAssetsHash: guardedAssetsHash(assets) } : proof : null,
          };
          if (sessionProof && record.origin === "chat") await this.origins.recordSession(record); else await this.origins.record(record);
        } catch (error) { emitChatDiagnostic(this.logger, { event: "chat.delivery.bookkeeping_failed", stage: "origin", ...safeFailure(error, "operation_error") }); }
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
