import type { Message } from "discord.js";
import type { MessageOriginStore } from "../../../application/chat/message-origin-store.js";

// One same-channel hop, only for an explicit Discord reply. No channel scan,
// recursive ancestry, or passive continuation fetch is authorized here.
export async function resolvesReplyToBot(message: Message, botId: string, origins: MessageOriginStore | null, timeoutMs = 1500, allowFetch = true): Promise<boolean> {
  if (!message.guildId || !message.reference?.messageId || message.reference.channelId && message.reference.channelId !== message.channelId) return false;
  const cached = message.mentions.repliedUser ?? message.channel.messages.cache?.get(message.reference.messageId)?.author;
  if (cached) return cached.id === botId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([ (async (): Promise<boolean> => {
      const origin = await origins?.find(message.guildId!, message.channelId, message.reference!.messageId!).catch(() => null);
      if (origin) return origin.origin === "chat";
      if (!allowFetch) return false;
      const target = await message.channel.messages.fetch(message.reference!.messageId!);
      return target?.guildId === message.guildId && target.channelId === message.channelId && target.author.id === botId;
    })(), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }) ]);
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}
