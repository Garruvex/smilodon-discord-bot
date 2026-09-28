import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client, type Guild } from "discord.js";

// What campaign setup needs from Discord, apart from discord.js so setup can be
// tested with a fake: the D&D category, a game's two text channels, the Table
// Talk thread, the Games/Parties forums each campaign posts into, and a
// preflight of the bot's own permissions.
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
  // The "DnD Admin" role: a plain role with no permissions of its own.
  createRole(guildId: string, name: string, reason: string): Promise<string>;
  roleExists(guildId: string, roleId: string): Promise<boolean>;
  // Gives a member the game's role (a member who has left the server is skipped).
  grantRole(guildId: string, roleId: string, userId: string): Promise<void>;
  // Hides a channel from everyone except the role (a players-only game).
  restrictToRole(guildId: string, channelId: string, roleId: string, allowThreadMessages: boolean): Promise<void>;
  // The permissions the bot lacks (empty when it can set everything up).
  missingPermissions(guildId: string, categoryId: string | null): Promise<readonly string[]>;

  // A forum channel: one of Public/Private Games or Parties. Its available
  // tags are campaign status labels (Recruiting/Active/Paused/Completed for
  // Games; Parties has none). A private forum is hidden from everyone but its
  // viewer role, the same way a players-only text channel is restricted.
  createForum(guildId: string, options: ForumOptions, reason: string): Promise<string>;
  forumExists(guildId: string, forumId: string): Promise<boolean>;
  // A campaign's post: a forum thread whose starter message is its status
  // card. The marker is folded invisibly into the thread's own name (forum
  // threads have no topic field to carry it in), so a leftover from an
  // uncertain create can be found again without duplicating it.
  createForumPost(options: ForumPostOptions, reason: string): Promise<ForumPost>;
  findForumPostByMarker(forumId: string, marker: string): Promise<string | null>;
  forumPostExists(postId: string): Promise<boolean>;
  // Applies one of the forum's status tags to a post, replacing any it had.
  setForumPostTag(forumId: string, postId: string, tag: string | null, reason: string): Promise<void>;
  // Closes a finished campaign's post to further replies without deleting its history.
  archiveForumPost(postId: string, locked: boolean, reason: string): Promise<void>;
}

export interface TextChannelOptions {
  readonly name: string;
  readonly topic: string;
  readonly parentId: string | null;
  // Players cannot type here; they act through buttons and forms.
  readonly playersReadOnly: boolean;
  // Players may write in threads under this channel (the Table Talk thread).
  readonly allowThreadMessages: boolean;
  // A players-only game's role: the channel is made visible to it alone.
  readonly viewerRoleId?: string | null;
}

export interface ForumOptions {
  readonly name: string;
  readonly topic: string;
  readonly parentId: string | null;
  // Status labels campaigns are tagged with (e.g. Recruiting/Active/Paused/Completed).
  readonly tags: readonly string[];
  // A private forum (Private Games/Parties): hidden from everyone but the role.
  readonly viewerRoleId?: string | null;
}

export interface ForumPostOptions {
  readonly forumId: string;
  readonly name: string;
  // The starter message's content (a status card payload's text form).
  readonly content: string;
  readonly marker: string;
}

export interface ForumPost {
  readonly postId: string;
  readonly starterMessageId: string;
}

// Forum threads have no topic field, so the marker rides along in the
// starter message instead, as a trailing subtext line (the same "-# " small-
// text convention hub-card.ts already uses) rather than in the thread's own
// visible title.
export const withMarker = (content: string, marker: string): string => `${content}\n-# ${marker}`;

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

const viewerAllowed = (allowThreadMessages: boolean): bigint[] => [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  ...(allowThreadMessages ? [PermissionFlagsBits.SendMessagesInThreads] : []),
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
        options.viewerRoleId === undefined || options.viewerRoleId === null
          ? {
              id: guild.roles.everyone.id,
              ...(options.playersReadOnly
                ? { deny: playerDenied, ...(options.allowThreadMessages ? { allow: [PermissionFlagsBits.SendMessagesInThreads] } : {}) }
                : {}),
            }
          : { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, ...playerDenied] },
        ...(options.viewerRoleId === undefined || options.viewerRoleId === null ? [] : [{ id: options.viewerRoleId, allow: viewerAllowed(options.allowThreadMessages) }]),
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

  public async createRole(guildId: string, name: string, reason: string): Promise<string> {
    const guild = await this.guild(guildId);
    return (await guild.roles.create({ name, mentionable: false, permissions: [], reason })).id;
  }

  public async roleExists(guildId: string, roleId: string): Promise<boolean> {
    return (await (await this.guild(guildId)).roles.fetch(roleId).catch(() => null)) !== null;
  }

  public async grantRole(guildId: string, roleId: string, userId: string): Promise<void> {
    const guild = await this.guild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member === null) return;
    await member.roles.add(roleId, "D&D campaign: player role");
  }

  public async restrictToRole(guildId: string, channelId: string, roleId: string, allowThreadMessages: boolean): Promise<void> {
    const guild = await this.guild(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) throw new Error(`Channel ${channelId} is not a text channel.`);
    const reason = "D&D campaign: players-only game";
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason });
    await channel.permissionOverwrites.edit(
      roleId,
      { ViewChannel: true, ReadMessageHistory: true, ...(allowThreadMessages ? { SendMessagesInThreads: true } : {}) },
      { reason },
    );
  }

  public async missingPermissions(guildId: string, categoryId: string | null): Promise<readonly string[]> {
    const guild = await this.guild(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const category = categoryId === null ? null : await guild.channels.fetch(categoryId).catch(() => null);
    const held = category === null ? me.permissions : category.permissionsFor(me);
    const missing = botPermissions.filter((flag) => held?.has(flag) !== true);
    return new PermissionsBitField(missing).toArray();
  }

  public async createForum(guildId: string, options: ForumOptions, reason: string): Promise<string> {
    const guild = await this.guild(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const forum = await guild.channels.create({
      name: options.name,
      type: ChannelType.GuildForum,
      topic: options.topic,
      availableTags: options.tags.map((name) => ({ name })),
      ...(options.parentId === null ? {} : { parent: options.parentId }),
      permissionOverwrites: [
        options.viewerRoleId === undefined || options.viewerRoleId === null
          ? { id: guild.roles.everyone.id }
          : { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...(options.viewerRoleId === undefined || options.viewerRoleId === null
          ? []
          : [{ id: options.viewerRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads] }]),
        { id: me.id, allow: botPermissions },
      ],
      reason,
    });
    return forum.id;
  }

  public async forumExists(guildId: string, forumId: string): Promise<boolean> {
    const channel = await (await this.guild(guildId)).channels.fetch(forumId).catch(() => null);
    return channel?.type === ChannelType.GuildForum;
  }

  public async createForumPost(options: ForumPostOptions, reason: string): Promise<ForumPost> {
    const forum = await this.client.channels.fetch(options.forumId);
    if (forum?.type !== ChannelType.GuildForum) throw new Error(`Channel ${options.forumId} is not a forum.`);
    const post = await forum.threads.create({
      name: options.name.slice(0, 100),
      message: { content: withMarker(options.content, options.marker) },
      reason,
    });
    const starter = await post.fetchStarterMessage();
    return { postId: post.id, starterMessageId: starter?.id ?? post.id };
  }

  // Only used to resume an uncertain create; walks every post's starter
  // message, so it is never used on a hot path.
  public async findForumPostByMarker(forumId: string, marker: string): Promise<string | null> {
    const forum = await this.client.channels.fetch(forumId);
    if (forum?.type !== ChannelType.GuildForum) return null;
    const [active, archived] = await Promise.all([forum.threads.fetchActive(), forum.threads.fetchArchived()]);
    for (const post of [...active.threads.values(), ...archived.threads.values()]) {
      const starter = await post.fetchStarterMessage().catch(() => null);
      if (starter?.content.includes(marker) === true) return post.id;
    }
    return null;
  }

  public async forumPostExists(postId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(postId).catch(() => null);
    return channel?.isThread() === true;
  }

  public async setForumPostTag(forumId: string, postId: string, tag: string | null, reason: string): Promise<void> {
    const forum = await this.client.channels.fetch(forumId);
    if (forum?.type !== ChannelType.GuildForum) throw new Error(`Channel ${forumId} is not a forum.`);
    const post = await this.client.channels.fetch(postId);
    if (post?.isThread() !== true) throw new Error(`Channel ${postId} is not a forum post.`);
    const tagId = tag === null ? null : forum.availableTags.find((available) => available.name === tag)?.id;
    await post.setAppliedTags(tagId === undefined || tagId === null ? [] : [tagId], reason);
  }

  public async archiveForumPost(postId: string, locked: boolean, reason: string): Promise<void> {
    const post = await this.client.channels.fetch(postId);
    if (post?.isThread() !== true) throw new Error(`Channel ${postId} is not a forum post.`);
    if (locked) await post.setLocked(true, reason);
    await post.setArchived(true, reason);
  }

  private guild(guildId: string): Promise<Guild> {
    return this.client.guilds.fetch(guildId);
  }
}
