import type { Client } from "discord.js";

export type DiscordSnapshotChange = "connection_unavailable" | "revision_capacity" | "shard_disconnect" | "shard_reconnecting" | "shard_resume" |
  "message_update" | "message_delete" | "message_delete_bulk" | "guild_member_update" | "guild_member_remove" |
  "role_update" | "role_delete" | "role_create" | "channel_update" | "channel_delete" | "thread_update" | "thread_delete" | "thread_members_update" | "guild_delete";
interface Revisions { epoch: number; epochCause: DiscordSnapshotChange; sequence: number; guilds: Map<string, number>; guildCauses: Map<string, DiscordSnapshotChange>;
  channels: Map<string, number>; messages: Map<string, { sequence: number; change: DiscordSnapshotChange }> }
const clients = new WeakMap<Client, Revisions>();
const limit = 4096;

// One set of metadata-only listeners per client, never one listener per turn.
// Updates invalidate active snapshots; ordinary new chat does not. Reconnection
// invalidates everything because events may have been missed while disconnected.
export function discordContextSnapshotCurrent(client: Client, guildId: string, channelId: string, sourceIds?: () => Iterable<string>,
  invalidated?: (change: DiscordSnapshotChange, messageId?: string) => void): (() => boolean) | null {
  if (typeof client.on !== "function" || typeof client.isReady !== "function") return null;
  let state = clients.get(client);
  if (!state) {
    state = { epoch: 0, epochCause: "revision_capacity", sequence: 0, guilds: new Map(), guildCauses: new Map(), channels: new Map(), messages: new Map() }; clients.set(client, state);
    const revisions = state;
    const bump = (map: Map<string, number>, id: string): void => {
      if (map.size >= limit && !map.has(id)) { revisions.epoch++; revisions.epochCause = "revision_capacity"; map.clear(); }
      map.set(id, (map.get(id) ?? 0) + 1);
    };
    const guild = (id: string, change: DiscordSnapshotChange): void => {
      if (revisions.guilds.size >= limit && !revisions.guilds.has(id)) revisions.guildCauses.clear();
      bump(revisions.guilds, id); revisions.guildCauses.set(id, change);
    };
    const channel = (id: string): void => bump(revisions.channels, id);
    const messageChanged = (channelId: string, messageId: string, change: DiscordSnapshotChange): void => {
      channel(channelId);
      if (revisions.messages.size >= limit && !revisions.messages.has(`${channelId}:${messageId}`)) { revisions.epoch++; revisions.epochCause = "revision_capacity"; revisions.messages.clear(); }
      revisions.messages.set(`${channelId}:${messageId}`, { sequence: ++revisions.sequence, change });
    };
    client.on("messageUpdate", (_old, message) => messageChanged(message.channelId, message.id, "message_update"));
    client.on("messageDelete", (message) => messageChanged(message.channelId, message.id, "message_delete"));
    client.on("messageDeleteBulk", (messages, source) => { for (const id of messages.keys()) messageChanged(source.id, id, "message_delete_bulk"); });
    client.on("guildMemberUpdate", (_old, member) => guild(member.guild.id, "guild_member_update"));
    client.on("guildMemberRemove", (member) => guild(member.guild.id, "guild_member_remove"));
    client.on("roleUpdate", (_old, role) => guild(role.guild.id, "role_update"));
    client.on("roleDelete", (role) => guild(role.guild.id, "role_delete"));
    client.on("roleCreate", (role) => guild(role.guild.id, "role_create"));
    client.on("channelUpdate", (_old, source) => { if ("guildId" in source) guild(source.guildId, "channel_update"); });
    client.on("channelDelete", (source) => { if ("guildId" in source) guild(source.guildId, "channel_delete"); });
    client.on("threadUpdate", (_old, thread) => guild(thread.guildId, "thread_update"));
    client.on("threadDelete", (thread) => guild(thread.guildId, "thread_delete"));
    client.on("threadMembersUpdate", (_added, _removed, thread) => guild(thread.guildId, "thread_members_update"));
    client.on("guildDelete", (source) => guild(source.id, "guild_delete"));
    client.on("shardDisconnect", () => { revisions.epoch++; revisions.epochCause = "shard_disconnect"; });
    client.on("shardReconnecting", () => { revisions.epoch++; revisions.epochCause = "shard_reconnecting"; });
    client.on("shardResume", () => { revisions.epoch++; revisions.epochCause = "shard_resume"; });
  }
  const sequence = state.sequence;
  const epoch = state.epoch; const guildVersion = state.guilds.get(guildId) ?? 0;
  const version = `${state.epoch}:${state.guilds.get(guildId) ?? 0}:${sourceIds ? 0 : state.channels.get(channelId) ?? 0}`;
  let reported = false;
  const reject = (change: DiscordSnapshotChange, messageId?: string): false => {
    if (!reported) { reported = true; invalidated?.(change, messageId); } return false;
  };
  return (): boolean => {
    if (!client.isReady()) return reject("connection_unavailable");
    if (state.epoch !== epoch) return reject(state.epochCause);
    if ((state.guilds.get(guildId) ?? 0) !== guildVersion) return reject(state.guildCauses.get(guildId) ?? "revision_capacity");
    if (sourceIds) for (const id of sourceIds()) {
      const changed = state.messages.get(`${channelId}:${id}`);
      if (changed && changed.sequence > sequence) return reject(changed.change, id);
    }
    return version === `${state.epoch}:${state.guilds.get(guildId) ?? 0}:${sourceIds ? 0 : state.channels.get(channelId) ?? 0}`;
  };
}
