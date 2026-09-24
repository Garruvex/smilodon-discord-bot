import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import { texts, type Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { formatOptionValue } from "../engine/format-option-value.js";
import { channel, group, report, roleList, setting } from "../registry/builders.js";
import type { OptionContext, Patch, RoleListOption } from "../registry/types.js";

type RoleGroup = "botAdministrator" | "musicController" | "restricted" | "chatbot";

// Refuse to empty a role group something still depends on: without a
// bot-admin role nobody but Manage Server can reach /settings again, and an
// enabled feature with no allowed role is silently unusable.
function requiredRoles(group: RoleGroup, next: readonly string[], context: OptionContext): string | null {
  if (next.length > 0) return null;
  const needed = group === "botAdministrator" ||
    (group === "musicController" && context.profile.features.music) ||
    (group === "chatbot" && context.profile.features.chatbot);
  return needed ? context.error("required") : null;
}

const roleGroup = (
  group: RoleGroup,
  write: (ids: string[]) => Patch,
): RoleListOption => roleList({
  read: (p) => [...p.roles[group]],
  write: (v) => write([...v]),
  validate: (v, context) => requiredRoles(group, v, context),
});

const roleOptions = {
  administrator: roleGroup("botAdministrator", (ids) => ({ botAdministratorRoleIds: ids })),
  "music-controller": roleGroup("musicController", (ids) => ({ musicControllerRoleIds: ids })),
  chatbot: roleGroup("chatbot", (ids) => ({ chatbotRoleIds: ids })),
  restricted: roleGroup("restricted", (ids) => ({ restrictedRoleIds: ids })),
};

const defaultAuditCount = 10;

export const access = group("access", [
  setting("roles", roleOptions, { setup: true }),

  setting("admin-panel", {
    channel: channel({
      textOnly: true,
      clearable: true,
      read: (p) => p.channels.adminPanel,
      write: (v) => ({ adminPanelChannelId: v }),
    }),
  }),

  setting("audit-log", {
    channel: channel({
      textOnly: true,
      clearable: true,
      read: (p) => p.channels.auditLog,
      write: (v) => ({ auditLogChannelId: v }),
    }),
  }, { setup: true }),

  // Who holds each access group, and what the group allows.
  report("access", ({ profile, text, request }) => Promise.resolve(accessSummary(profile, text, texts[request.language].settings))),

  report("audit", async ({ deps, request, text, path, values }) => {
    if (!deps.auditLogService) return text.message(path, "unavailable");
    const result = await deps.auditLogService.fetchRecent(request.guildId, values.getInteger("count") ?? defaultAuditCount);
    if (!result.configured) return text.message(path, "not-configured");
    if (result.entries.length === 0) return text.message(path, "empty");
    const lines = result.entries.map((entry) =>
      `<t:${Math.floor(entry.createdAt / 1_000)}:R> ${entry.description.replaceAll("\n", " · ")}`);
    return [text.message(path, "heading"), ...lines].join("\n").slice(0, 2_000);
  }, {
    count: { kind: "integer", min: 1, max: 20 },
  }),
]);

function accessSummary(
  profile: GuildConfiguration,
  text: SettingsText,
  ui: Texts["settings"],
): string {
  return Object.entries(roleOptions).map(([name, option]) => {
    const key = `access.roles.${name}`;
    return `**${text.label(key)}:** ${formatOptionValue(option, key, option.read(profile), text, ui)}\n-# ${text.description(key)}`;
  }).join("\n");
}
