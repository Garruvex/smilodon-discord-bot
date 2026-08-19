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
  | { allowed: true }
  | { allowed: false; reason: AccessDenialReason };
