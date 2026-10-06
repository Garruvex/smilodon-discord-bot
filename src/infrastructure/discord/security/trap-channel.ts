import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel, type TextChannel } from "discord.js";

import { languages } from "../../../application/i18n/language.js";
import { texts } from "../../../application/i18n/texts.js";

// Names a real server could plausibly have. A bot that skips channels called
// "honeypot" or "do-not-post" has nothing to skip here, and the name differs
// from server to server so there is no fixed one to learn.
const trapChannelNames = ["general-2", "general-chat", "general-talk", "general-lounge", "main-chat", "chat-2"] as const;

export function pickTrapChannelName(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const free = trapChannelNames.filter((name) => !taken.has(name));
  const pool = free.length > 0 ? free : trapChannelNames;
  const name = pool[Math.floor(random() * pool.length)] ?? trapChannelNames[0];
  return free.length > 0 ? name : `${name}-${Math.floor(random() * 900 + 100)}`;
}

// One message that says the same thing in every language the bot speaks, so
// a member of any of them who finds the channel knows to leave it alone.
export function trapNoticeContent(): string {
  return languages
    .map((language) => `**${texts[language].security.trap.noticeTitle}**\n${texts[language].security.trap.noticeBody}`)
    .join("\n\n");
}

function trapTopic(): string {
  return languages.map((language) => texts[language].security.trap.topic).join(" · ");
}

// A category everyone can see, so the new channel sits in the ordinary list
// (last in it) instead of under a private category that would hide it from
// the very accounts it is there to catch. Null when the guild has none.
function visibleLastCategory(guild: Guild): string | null {
  const everyone = guild.roles.everyone;
  const categories = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .filter((channel) => channel.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel))
    .sort((left, right) => left.position - right.position);
  return categories.last()?.id ?? null;
}

const botPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

// Posts the notice (and pins it, and sets the topic) in a channel that is
// meant to stay empty. Pinning and the topic are best effort: the notice is
// what matters, and a missing permission for either must not undo it.
export async function postTrapNotice(channel: TextChannel): Promise<void> {
  const message = await channel.send({ content: trapNoticeContent(), allowedMentions: { parse: [] } });
  await message.pin().catch(() => undefined);
  await channel.setTopic(trapTopic()).catch(() => undefined);
}

export async function createTrapChannel(guild: Guild): Promise<TextChannel> {
  const me = guild.members.me;
  const taken = new Set(guild.channels.cache.map((channel) => channel.name));
  const parent = visibleLastCategory(guild);
  const channel = await guild.channels.create({
    name: pickTrapChannelName(taken),
    type: ChannelType.GuildText,
    ...(parent ? { parent } : {}),
    // The bot keeps its own access whatever the category or @everyone say.
    ...(me ? { permissionOverwrites: [{ id: me.id, allow: botPermissions }] } : {}),
    reason: "Security channel set up from the settings panel",
  });
  await postTrapNotice(channel);
  return channel;
}

export function isPostableTextChannel(channel: GuildBasedChannel | null | undefined): channel is TextChannel {
  return channel?.type === ChannelType.GuildText;
}
