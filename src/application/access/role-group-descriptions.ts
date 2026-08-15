export const roleGroupDescriptions = {
  botAdministrator:
    "Manages /settings and inherits every music-controller permission.",
  musicController:
    "Required for /play, queue commands, panel controls, and typed song requests in the control channel.",
  restricted:
    "Denied from music and chatbot features unless a configured bot owner bypass applies.",
  chatbot:
    "Allowed to mention the bot for AI chat when the chatbot feature is enabled.",
} as const;

export type RoleGroupDescriptionKey = keyof typeof roleGroupDescriptions;

export function formatRoleGroupList(
  roleIds: ReadonlySet<string>,
): string {
  if (roleIds.size === 0) {
    return "none configured";
  }
  return [...roleIds].map((roleId) => `<@&${roleId}>`).join(", ");
}
