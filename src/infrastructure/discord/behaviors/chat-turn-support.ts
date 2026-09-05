import type { Attachment, Message } from "discord.js";
import type { Logger } from "pino";

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
  content: string;
  files: readonly { attachment: Buffer; name: string }[];
}

export interface ChatDeliverySender {
  // Sends the very first message of the reply — usually message.reply(...),
  // or editing an existing "thinking…"/image-generation-preview placeholder.
  // A failure here (after retries) propagates to the caller: nothing was
  // delivered at all, so the caller's normal top-level error handling is
  // the correct response.
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
  let lastError: unknown;
  for (let attempt = 1; attempt <= deliveryRetryAttempts; attempt++) {
    try {
      return await send();
    } catch (error) {
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
  public constructor(private readonly logger: Logger) {}

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
      // bypassVoiceChannelCheck is a placeholder here — false, the safe
      // default — because DJ-mode eligibility depends on live role state,
      // just like the role gate below. Every music tool call re-derives the
      // real value from evaluateMusicToolAccess's fresh decision right
      // before it touches PlaybackService (see e.g. pause-command.ts's
      // executeAsTool), rather than trusting this turn-start snapshot.
      actor: createPlaybackActorFromMember(message.guildId, musicTextChannelId, member, false),
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
    let current: Message = message;
    let remainingChars = chatMemoryLimits.maxReplyChainChars;
    for (let depth = 0; depth < chatMemoryLimits.maxReplyChainDepth; depth++) {
      const referenceId = current.reference?.messageId;
      if (!referenceId) break;
      const parent = await current.channel.messages.fetch(referenceId).catch(() => null);
      if (!parent) break;
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
      if (!parent) break;
      const contentLength = Math.min(parent.content.length, chatMemoryLimits.maxUserMessageChars);
      if (overflow.length > 0 && contentLength > overflowChars) break;
      overflowChars -= contentLength;
      overflow.push(parent);
      current = parent;
    }
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
  public async resolveChannelHistory(
    message: Message,
    limit: number,
    excludeIds: ReadonlySet<string>,
  ): Promise<Message[]> {
    // Oversample the raw fetch (Discord's own per-request cap is 100, so
    // this never costs an extra round trip) — a flat "last `limit` from
    // anyone" fetch lets our own replies, which appear after nearly every
    // human turn in a busy channel, eat half or more of a small window,
    // leaving too few distinct human messages for the model to reliably
    // track who said what across several people talking at once.
    const fetchLimit = Math.min(limit * 4, 100);
    const fetched = await message.channel.messages.fetch({ limit: fetchLimit, before: message.id }).catch(() => null);
    if (!fetched) return [];
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
    let remainingChars = chatMemoryLimits.maxChannelHistoryChars;
    const kept: Message[] = [];
    // Discord returns newest-first; walk nearest-to-current first so
    // recency wins once a budget is hit, then reverse for oldest-first
    // display (matching resolveReplyChain's convention).
    for (const candidate of fetched.values()) {
      if (excludeIds.has(candidate.id)) continue;
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
        ? selectedById.get(referenceId) ?? message.channel.messages.cache.get(referenceId)
        : undefined;
      return {
        authorId: message.author.id,
        authorDisplayName: message.member?.displayName ?? message.author.displayName,
        content: message.content.slice(0, chatMemoryLimits.maxUserMessageChars),
        imageCount: [...message.attachments.values()].filter((attachment) =>
          attachment.contentType?.startsWith("image/"),
        ).length,
        replyToAuthorId: target?.author.id ?? null,
        replyToAuthorDisplayName: target
          ? target.member?.displayName ?? target.author.displayName
          : null,
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
          images: droppedUnsupportedAttachments.map((attachment) => ({
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
          })),
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
        { name: attachment.name, url: attachment.url },
        "Dropped image attachment: URL failed host allow-list check",
      );
      return null;
    }
    const response = await fetch(url, {
      headers: { Accept: contentType },
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      this.logger.warn({ name: attachment.name, error }, "Dropped image attachment: fetch failed");
      return null;
    });
    if (!response) return null;
    if (!response.ok) {
      this.logger.warn(
        { name: attachment.name, status: response.status },
        "Dropped image attachment: fetch returned a non-OK status",
      );
      return null;
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > maximumImageBytes) {
      this.logger.warn(
        { name: attachment.name, bytes: data.length },
        "Dropped image attachment: downloaded size out of bounds",
      );
      return null;
    }
    const actualContentType = this.detectImageContentType(data);
    if (!actualContentType) {
      this.logger.warn(
        { name: attachment.name, contentType, actualHeaderBytes: data.subarray(0, 12).toString("hex") },
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
    maxImageAggregateBytes: number;
  }): Promise<{ deliveredText: string }> {
    const plan = planChatDelivery(params.text, params.sources);
    const imagePlan = planImageDelivery(params.images, params.maxImageAggregateBytes);

    const sends: { content: string; files: { attachment: Buffer; name: string }[] }[] = plan.mode === "attachment"
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

    const [firstSend, ...restSends] = sends;
    await sendWithRetry(() => params.sender.first(firstSend!));
    for (const send of restSends) {
      try {
        await sendWithRetry(() => params.sender.rest(send));
      } catch (error) {
        this.logger.warn({ error }, "Chat reply delivery failed partway through a multi-message response");
        await params.sender.rest({
          content: "(The rest of that reply couldn't be delivered — please try again.)",
          files: [],
        }).catch(() => undefined);
        break;
      }
    }
    return { deliveredText: params.text };
  }
}
