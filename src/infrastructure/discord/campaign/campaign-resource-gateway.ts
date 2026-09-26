import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client, type Guild } from "discord.js";

// What campaign setup needs from Discord, apart from discord.js so setup can be
// tested with a fake: the D&D category, a game's two text channels, the Table
// Talk thread, and a preflight of the bot's own permissions.
export interface CampaignResourceGateway {
  createCategory(guildId: string, name: string, reason: string): Promise<string>;
  categoryExists(guildId: string, categoryId: string): Promise<boolean>;
  createTextChannel(guildId: string, options: TextChannelOptions, reason: string): Promise<string>;
  channelExists(guildId: string, channelId: string): Promise<boolean>;
  // A channel in the category whose topic carries the marker, for resuming an
  // uncertain create instead of duplicating it.
  findTextChannelByMarker(guildId: string, categoryId: string | null, marker: string): Promise<string | null>;
  // Names of the channels in the category (or the whole server when null).
  channelNames(guildId: string, categoryId: string | null): Promise<ReadonlySet<string>>;
  createDiscussionThread(channelId: string, name: string, reason: string): Promise<string>;
  findThreadByName(channelId: string, name: string): Promise<string | null>;
  threadExists(threadId: string): Promise<boolean>;
  // The permissions the bot lacks (empty when it can set everything up).
  missingPermissions(guildId: string, categoryId: string | null): Promise<readonly string[]>;
}

export interface TextChannelOptions {
  readonly name: string;
  readonly topic: string;
  readonly parentId: string | null;
  // Players cannot type here; they act through buttons and forms.
  readonly playersReadOnly: boolean;
  // Players may write in threads under this channel (the Table Talk thread).
  readonly allowThreadMessages: boolean;
}

const botPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.PinMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];

const playerDenied = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads];

export class DiscordResourceGateway implements CampaignResourceGateway {
  public constructor(private readonly client: Client) {}

  public async createCategory(guildId: string, name: string, reason: string): Promise<string> {
    const guild = await this.guild(guildId);
    return (await guild.channels.create({ name, type: ChannelType.GuildCategory, reason })).id;
  }

  public async categoryExists(guildId: string, categoryId: string): Promise<boolean> {
    const channel = await (await this.guild(guildId)).channels.fetch(categoryId).catch(() => null);
    return channel?.type === ChannelType.GuildCategory;
  }

  public async createTextChannel(guildId: string, options: TextChannelOptions, reason: string): Promise<string> {
    const guild = await this.guild(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const channel = await guild.channels.create({
      name: options.name,
      type: ChannelType.GuildText,
      topic: options.topic,
      ...(options.parentId === null ? {} : { parent: options.parentId }),
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          ...(options.playersReadOnly
            ? { deny: playerDenied, ...(options.allowThreadMessages ? { allow: [PermissionFlagsBits.SendMessagesInThreads] } : {}) }
            : {}),
        },
        { id: me.id, allow: botPermissions },
      ],
      reason,
    });
    return channel.id;
  }

  public async channelExists(guildId: string, channelId: string): Promise<boolean> {
    const channel = await (await this.guild(guildId)).channels.fetch(channelId).catch(() => null);
    return channel?.type === ChannelType.GuildText;
  }

  public async findTextChannelByMarker(guildId: string, categoryId: string | null, marker: string): Promise<string | null> {
    const channels = await (await this.guild(guildId)).channels.fetch();
    for (const channel of channels.values()) {
      if (channel?.type === ChannelType.GuildText && channel.parentId === categoryId && channel.topic?.includes(marker) === true) return channel.id;
    }
    return null;
  }

  public async channelNames(guildId: string, categoryId: string | null): Promise<ReadonlySet<string>> {
    const channels = await (await this.guild(guildId)).channels.fetch();
    return new Set([...channels.values()].flatMap((channel) => (channel !== null && (categoryId === null || channel.parentId === categoryId) ? [channel.name] : [])));
  }

  public async createDiscussionThread(channelId: string, name: string, reason: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) throw new Error(`Channel ${channelId} cannot hold a thread.`);
    return (await channel.threads.create({ name: name.slice(0, 100), type: ChannelType.PublicThread, autoArchiveDuration: 10_080, reason })).id;
  }

  public async findThreadByName(channelId: string, name: string): Promise<string | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) return null;
    const active = await channel.threads.fetchActive();
    return [...active.threads.values()].find((thread) => thread.name === name.slice(0, 100))?.id ?? null;
  }

  public async threadExists(threadId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() === true;
  }

  public async missingPermissions(guildId: string, categoryId: string | null): Promise<readonly string[]> {
    const guild = await this.guild(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const category = categoryId === null ? null : await guild.channels.fetch(categoryId).catch(() => null);
    const held = category === null ? me.permissions : category.permissionsFor(me);
    const missing = botPermissions.filter((flag) => held?.has(flag) !== true);
    return new PermissionsBitField(missing).toArray();
  }

  private guild(guildId: string): Promise<Guild> {
    return this.client.guilds.fetch(guildId);
  }
}
