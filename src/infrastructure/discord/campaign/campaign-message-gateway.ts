import { DiscordAPIError, RESTJSONErrorCodes, type Client, type GuildTextBasedChannel } from "discord.js";

import type { CardPayload } from "./card-payload.js";

// The message operations the campaign cards need, apart from discord.js so the
// card service can be tested with a fake. Sends return the message ID so it
// can be saved; edits report a message that no longer exists instead of
// throwing, because a deleted card is normal and is replaced.
export interface CampaignMessageGateway {
  send(channelId: string, payload: CardPayload): Promise<string>;
  edit(channelId: string, messageId: string, payload: CardPayload): Promise<"ok" | "missing">;
  // Deleting a message that is already gone is fine.
  remove(channelId: string, messageId: string): Promise<void>;
  // Plain history text (narration, results): no controls, no pings.
  post(channelId: string, content: string): Promise<string>;
  pin(channelId: string, messageId: string): Promise<void>;
}

const missingCodes: readonly number[] = [RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel];

export class DiscordMessageGateway implements CampaignMessageGateway {
  public constructor(private readonly client: Client) {}

  public async send(channelId: string, payload: CardPayload): Promise<string> {
    const message = await (await this.channel(channelId)).send(options(payload));
    return message.id;
  }

  public async edit(channelId: string, messageId: string, payload: CardPayload): Promise<"ok" | "missing"> {
    try {
      const channel = await this.channel(channelId);
      await channel.messages.edit(messageId, options(payload));
      return "ok";
    } catch (error) {
      if (error instanceof DiscordAPIError && missingCodes.includes(Number(error.code))) return "missing";
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

  public async post(channelId: string, content: string): Promise<string> {
    const message = await (await this.channel(channelId)).send({ content, allowedMentions: { parse: [] } });
    return message.id;
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

function options(payload: CardPayload): { components: CardPayload["components"]; flags: CardPayload["flags"]; allowedMentions: CardPayload["allowedMentions"] } {
  return { components: payload.components, flags: payload.flags, allowedMentions: payload.allowedMentions };
}
