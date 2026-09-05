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
  // bypassVoiceChannelCheck is Music-module-specific (DJ mode) and false for
  // every other module — see access-rules.ts's hasMusicDjPrivilege. Computed
  // here, once, as part of the same rule chain that already grants access,
  // so PlaybackService/command code never re-derives it from roles itself.
  | { allowed: true; bypassVoiceChannelCheck: boolean }
  | { allowed: false; reason: AccessDenialReason };
