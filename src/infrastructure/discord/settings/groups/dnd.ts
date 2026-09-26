import { action, group, report, setting, toggle } from "../registry/builders.js";

// Everything about D&D on a server, in one place: the on/off switch first,
// then where the games are shown and who runs them. The hub channel, category
// and DnD Admin role live with the campaign data (setup makes and repairs
// them), so those rows are actions that go through deps.campaign.
export const dnd = group("dnd", [
  setting("campaigns", {
    enabled: toggle({ read: (p) => p.features.campaign, write: (v) => ({ campaignEnabled: v }) }),
  }),

  report("status", async ({ deps, request, text, path }) => {
    const status = await deps.campaign?.status(request.guildId);
    if (status === undefined) return text.message(path, "unavailable");
    const none = text.message(path, "none");
    return [
      text.message(path, status.setUp ? "setUp" : "notSetUp"),
      text.message(path, "hub", { channel: status.hubChannelId === null ? none : `<#${status.hubChannelId}>` }),
      text.message(path, "role", { role: status.adminRoleId === null ? none : `<@&${status.adminRoleId}>` }),
      text.message(path, "games", { count: status.liveGames }),
      text.message(path, status.modelConfigured ? "modelReady" : "modelMissing"),
    ].join("\n");
  }),

  action("hub-channel", {
    params: { channel: { kind: "channel", textOnly: true, required: true } },
    run: async ({ deps, request, text, path, values }) => {
      const channelId = values.getChannel("channel")?.id;
      if (deps.campaign === undefined || channelId === undefined) return { ok: false, message: text.message(path, "unavailable") };
      const result = await deps.campaign.setUp(request.guildId, channelId);
      if (result.kind === "missingPermissions") {
        return { ok: false, message: text.message(path, "permissions", { missing: result.missing.join(", ") }) };
      }
      return { ok: true, message: text.message(path, "done", { channel: `<#${channelId}>` }) };
    },
  }),

  action("admin-role", {
    params: { role: { kind: "role", required: true } },
    run: async ({ deps, request, text, path, values }) => {
      const roleId = values.getRole("role")?.id;
      if (deps.campaign === undefined || roleId === undefined) return { ok: false, message: text.message(path, "unavailable") };
      const changed = await deps.campaign.setAdminRole(request.guildId, roleId);
      return changed
        ? { ok: true, message: text.message(path, "done", { role: `<@&${roleId}>` }) }
        : { ok: false, message: text.message(path, "notSetUp") };
    },
  }),

  action("repair", {
    params: {},
    run: async ({ deps, request, text, path }) => {
      if (deps.campaign === undefined) return { ok: false, message: text.message(path, "unavailable") };
      const result = await deps.campaign.setUp(request.guildId, null);
      if (result.kind === "missingPermissions") {
        return { ok: false, message: text.message(path, "permissions", { missing: result.missing.join(", ") }) };
      }
      return { ok: true, message: text.message(path, "done") };
    },
  }),
]);
