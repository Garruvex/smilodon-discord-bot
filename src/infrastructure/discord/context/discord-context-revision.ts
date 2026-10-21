import type { Client } from "discord.js";

interface Revisions { epoch: number; sequence: number; guilds: Map<string, number>; channels: Map<string, number>; messages: Map<string, number> }
const clients = new WeakMap<Client, Revisions>();
const limit = 4096;

// One set of metadata-only listeners per client, never one listener per turn.
// Updates invalidate active snapshots; ordinary new chat does not. Reconnection
// invalidates everything because events may have been missed while disconnected.
export function discordContextSnapshotCurrent(client: Client, guildId: string, channelId: string, sourceIds?: () => Iterable<string>): (() => boolean) | null {
  if (typeof client.on !== "function" || typeof client.isReady !== "function") return null;
  let state = clients.get(client);
  if (!state) {
    state = { epoch: 0, sequence: 0, guilds: new Map(), channels: new Map(), messages: new Map() }; clients.set(client, state);
    const revisions = state;
    const bump = (map: Map<string, number>, id: string): void => {
      if (map.size >= limit && !map.has(id)) { revisions.epoch++; map.clear(); }
      map.set(id, (map.get(id) ?? 0) + 1);
    };
    const guild = (id: string): void => bump(revisions.guilds, id);
    const channel = (id: string): void => bump(revisions.channels, id);
    const messageChanged = (channelId: string, messageId: string): void => {
      channel(channelId);
      if (revisions.messages.size >= limit && !revisions.messages.has(`${channelId}:${messageId}`)) { revisions.epoch++; revisions.messages.clear(); }
      revisions.messages.set(`${channelId}:${messageId}`, ++revisions.sequence);
    };
    client.on("messageUpdate", (_old, message) => messageChanged(message.channelId, message.id));
    client.on("messageDelete", (message) => messageChanged(message.channelId, message.id));
    client.on("messageDeleteBulk", (messages, source) => { for (const id of messages.keys()) messageChanged(source.id, id); });
    client.on("guildMemberUpdate", (_old, member) => guild(member.guild.id));
    client.on("guildMemberRemove", (member) => guild(member.guild.id));
    client.on("roleUpdate", (_old, role) => guild(role.guild.id));
    client.on("roleDelete", (role) => guild(role.guild.id));
    client.on("roleCreate", (role) => guild(role.guild.id));
    client.on("channelUpdate", (_old, source) => { if ("guildId" in source) guild(source.guildId); });
    client.on("channelDelete", (source) => { if ("guildId" in source) guild(source.guildId); });
    client.on("threadUpdate", (_old, thread) => guild(thread.guildId));
    client.on("threadDelete", (thread) => guild(thread.guildId));
    client.on("threadMembersUpdate", (_added, _removed, thread) => guild(thread.guildId));
    client.on("guildDelete", (source) => guild(source.id));
    client.on("shardDisconnect", () => { revisions.epoch++; });
    client.on("shardReconnecting", () => { revisions.epoch++; });
    client.on("shardResume", () => { revisions.epoch++; });
  }
  const sequence = state.sequence;
  const version = `${state.epoch}:${state.guilds.get(guildId) ?? 0}:${sourceIds ? 0 : state.channels.get(channelId) ?? 0}`;
  return (): boolean => client.isReady() && version === `${state.epoch}:${state.guilds.get(guildId) ?? 0}:${sourceIds ? 0 : state.channels.get(channelId) ?? 0}` &&
    (!sourceIds || [...sourceIds()].every((id) => (state.messages.get(`${channelId}:${id}`) ?? 0) <= sequence));
}
