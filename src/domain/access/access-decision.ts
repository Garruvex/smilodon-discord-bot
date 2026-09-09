export enum AccessDenialReason {
  GuildNotConfigured = "guild_not_configured",
  FeatureDisabled = "feature_disabled",
  OwnerOnly = "owner_only",
  RestrictedRole = "restricted_role",
  MissingRequiredRole = "missing_required_role",
  MissingMemberPermission = "missing_member_permission",
  BotMissingPermission = "bot_missing_permission",
  ChannelNotAllowed = "channel_not_allowed",
  GuildRequired = "guild_required",
}

export type AccessDecision =
  // bypassVoiceChannelCheck and allowQueueWithoutVoiceChannel are both
  // Music-module-specific and false for every other module — see
  // access-rules.ts's hasMusicDjPrivilege and access-policy-engine.ts.
  // Computed here, once, as part of the same rule chain that already grants
  // access, so PlaybackService/command code never re-derives them from
  // roles/guild config itself. bypassVoiceChannelCheck (DJ mode) relaxes the
  // voice-channel requirement for controlling an existing player.
  // allowQueueWithoutVoiceChannel (open queue requests) relaxes it for
  // enqueueing a new track instead — the two are independent settings.
  | { allowed: true; bypassVoiceChannelCheck: boolean; allowQueueWithoutVoiceChannel: boolean }
  | { allowed: false; reason: AccessDenialReason };
