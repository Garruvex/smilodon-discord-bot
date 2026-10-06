import type { Message } from "discord.js";

export type IsGameChannel = (guildId: string, channelIds: readonly string[]) => Promise<boolean>;

// The chatbot never speaks in a D&D game's Party or Adventure post: the game's
// own narrator and cards own those channels. Fails closed — if the lookup
// fails, the message is treated as a game channel and left unanswered.
export async function isInGameChannel(message: Message, isGameChannel: IsGameChannel | null): Promise<boolean> {
  if (isGameChannel === null || !message.inGuild()) return false;
  try {
    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    return await isGameChannel(message.guildId, parentId === null ? [message.channelId] : [message.channelId, parentId]);
  } catch {
    return true;
  }
}
