export type ChannelMemoryMode = "shared" | "isolated" | "session_only" | "disabled";

// Unlisted channels default to "shared" — today's behavior, unchanged.
export function resolveChannelMemoryMode(
  configuredModes: Readonly<Record<string, ChannelMemoryMode>>,
  channelId: string,
): ChannelMemoryMode {
  return configuredModes[channelId] ?? "shared";
}

export interface ResolvedMemoryScope {
  audience: "private" | "channel" | "guild";
  channelId: string | null;
  isolationChannelId: string | null;
}

// The one place the engine overrides what the model claims about a
// proposal's scope, based on the channel's configured mode — never the
// other way around. `requested.audience` is the model's original intent:
// "private" for a private-memory action, "guild" for a guild-knowledge
// candidate (with `channelScoped` narrowing it to this channel or not).
//
// In "isolated" mode the model's channelScoped flag becomes advisory-only:
// everything is force-scoped to the channel (isolationChannelId set),
// including anything the model tagged guild-wide — it can never escape as
// audience "guild" from an isolated channel.
export function resolveMemoryScope(
  mode: ChannelMemoryMode,
  channelId: string,
  requested: { audience: "private" | "guild"; channelScoped: boolean },
  sharedMemoryEnabled = false,
): ResolvedMemoryScope {
  if (!sharedMemoryEnabled && requested.audience === "private") {
    return { audience: "private", channelId: null, isolationChannelId: mode === "isolated" ? channelId : null };
  }
  if (mode === "isolated") {
    return { audience: "channel", channelId, isolationChannelId: channelId };
  }
  // Personal subject matter does not imply a private audience. All proposals
  // on this guild-channel ingestion path originate in eligible public chat;
  // configured channel modes, not the model, assign their allowed audience.
  return {
    audience: requested.channelScoped ? "channel" : "guild",
    channelId: requested.channelScoped ? channelId : null,
    isolationChannelId: null,
  };
}

// Whether durable writes are allowed at all in this channel mode.
export function allowsDurableWrites(mode: ChannelMemoryMode): boolean {
  return mode === "shared" || mode === "isolated";
}
