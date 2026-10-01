import { DiscordAPIError, EmbedBuilder, RESTJSONErrorCodes, type Client, type GuildTextBasedChannel } from "discord.js";

import type { CardPayload } from "./card-payload.js";
import { noIcons, type CampaignIcon, type CampaignIcons } from "./campaign-icons.js";

// The message operations the campaign cards need, apart from discord.js so the
// card service can be tested with a fake. Sends return the message ID so it
// can be saved; edits report a message that no longer exists instead of
// throwing, because a deleted card is normal and is replaced.
// How a history message looks, so the eye can tell the story from the mechanics. The story itself (narration, speech) is plain
// prose; declared intents are blue cards and resolved combat actions are red cards.
// Dice, rewards, table notices and hazards retain their own result styles.
export type MessageStyle = "intent" | "narration" | "roll" | "action" | "reward" | "notice" | "hazard";

const styleColors: Readonly<Record<Exclude<MessageStyle, "narration">, number>> = { intent: 0x3498db, roll: 0x5865f2, action: 0xed4245, reward: 0xf1c40f, notice: 0x9b59b6, hazard: 0xe67e22 };

export interface CampaignMessageGateway {
  send(channelId: string, payload: CardPayload): Promise<string>;
  edit(channelId: string, messageId: string, payload: CardPayload): Promise<"ok" | "missing">;
  exists(channelId: string, messageId: string): Promise<boolean>;
  // Deleting a message that is already gone is fine.
  remove(channelId: string, messageId: string): Promise<void>;
  // Plain history text (narration, results): no controls, no pings.
  // The named users (and only they) are pinged.
  // `nonce` (at most 25 characters) makes Discord drop a repeat of the same
  // message sent within a few minutes, so a retry after an unsure send does not double-post.
  post(channelId: string, content: string, mentionUserIds?: readonly string[], nonce?: string, style?: MessageStyle): Promise<string>;
  // Rewrites a message made with post (the staged dice reveal). A missing
  // placeholder must be reported so the result can be posted separately.
  editText(channelId: string, messageId: string, content: string, style?: MessageStyle): Promise<"ok" | "missing">;
  pin(channelId: string, messageId: string): Promise<void>;
  // A picture attachment. The caption (the scene, creature or hero it shows) is its alt text and a small line beneath, never a retelling of the narration.
  sendImage(channelId: string, bytes: Buffer, mediaType: string, caption: string): Promise<void>;
}

const missingCodes: readonly number[] = [RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel];

export class DiscordMessageGateway implements CampaignMessageGateway {
  public constructor(
    private readonly client: Client,
    private readonly icons: CampaignIcons = noIcons,
  ) {}

  public async send(channelId: string, payload: CardPayload): Promise<string> {
    const message = await (await this.channel(channelId)).send(options(payload));
    return message.id;
  }

  public async edit(channelId: string, messageId: string, payload: CardPayload): Promise<"ok" | "missing"> {
    try {
      const channel = await this.channel(channelId);
      await channel.messages.edit(messageId, editOptions(payload));
      return "ok";
    } catch (error) {
      if (error instanceof DiscordAPIError && missingCodes.includes(Number(error.code))) return "missing";
      throw error;
    }
  }

  public async exists(channelId: string, messageId: string): Promise<boolean> {
    try {
      // Force a REST lookup: a deleted message can still be in discord.js's cache.
      await (await this.channel(channelId)).messages.fetch({ message: messageId, force: true });
      return true;
    } catch (error) {
      if (error instanceof DiscordAPIError && missingCodes.includes(Number(error.code))) return false;
      throw error;
    }
  }

  public async remove(channelId: string, messageId: string): Promise<void> {
    try {
      const channel = await this.channel(channelId);
      await channel.messages.delete(messageId);
    } catch (error) {
      if (error instanceof DiscordAPIError && missingCodes.includes(Number(error.code))) return;
      throw error;
    }
  }

  public async post(channelId: string, content: string, mentionUserIds: readonly string[] = [], nonce?: string, style?: MessageStyle): Promise<string> {
    const message = await (await this.channel(channelId)).send({
      ...body(content, style, this.icons),
      allowedMentions: mentionUserIds.length === 0 ? { parse: [] } : { parse: [], users: [...mentionUserIds] },
      ...(nonce === undefined ? {} : { nonce, enforceNonce: true }),
    });
    return message.id;
  }

  public async editText(channelId: string, messageId: string, content: string, style?: MessageStyle): Promise<"ok" | "missing"> {
    try {
      const channel = await this.channel(channelId);
      await channel.messages.edit(messageId, { ...body(content, style, this.icons), allowedMentions: { parse: [] } });
      return "ok";
    } catch (error) {
      if (error instanceof DiscordAPIError && missingCodes.includes(Number(error.code))) return "missing";
      throw error;
    }
  }

  public async sendImage(channelId: string, bytes: Buffer, mediaType: string, caption: string): Promise<void> {
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : "png";
    await (await this.channel(channelId)).send({ content: `-# 🖼 ${caption}`, files: [{ attachment: bytes, name: `picture.${extension}`, description: caption.slice(0, 1_000) }], allowedMentions: { parse: [] } });
  }

  public async pin(channelId: string, messageId: string): Promise<void> {
    const channel = await this.channel(channelId);
    await channel.messages.pin(messageId);
  }

  private async channel(channelId: string): Promise<GuildTextBasedChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) throw new Error(`Channel ${channelId} is not a guild text channel.`);
    return channel;
  }
}

// The icon in the corner of each kind of panel.
const styleIcons: Readonly<Partial<Record<MessageStyle, CampaignIcon>>> = { roll: "roll", action: "attack", reward: "reward", notice: "notice", hazard: "hazard" };

function body(content: string, style: MessageStyle | undefined, icons: CampaignIcons): { content: string; embeds: EmbedBuilder[] } {
  if (style === undefined || style === "narration") return { content, embeds: [] };
  const embed = new EmbedBuilder().setColor(styleColors[style]).setDescription(content);
  const iconName = styleIcons[style];
  const icon = iconName === undefined ? undefined : icons.emoji(iconName);
  return { content: "", embeds: [icon === undefined ? embed : embed.setThumbnail(`https://cdn.discordapp.com/emojis/${icon.id}.png?size=64`)] };
}

function options(payload: CardPayload): { components: CardPayload["components"]; flags: CardPayload["flags"]; allowedMentions: CardPayload["allowedMentions"]; files?: { attachment: Buffer; name: string }[] } {
  const files = (payload.files ?? []).map((file) => ({ attachment: file.bytes, name: file.name }));
  return { components: payload.components, flags: payload.flags, allowedMentions: payload.allowedMentions, ...(files.length === 0 ? {} : { files }) };
}

// An edit that carries pictures replaces the message's attachments with exactly those.
function editOptions(payload: CardPayload): ReturnType<typeof options> & { attachments?: [] } {
  return { ...options(payload), ...((payload.files ?? []).length === 0 ? {} : { attachments: [] }) };
}
