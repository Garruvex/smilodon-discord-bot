import { PermissionFlagsBits } from "discord.js";

import {
  trapActions,
  trapDeleteWindows,
  trapTimeoutDurations,
} from "../../../../domain/security/trap-policy.js";
import { createTrapChannel, isPostableTextChannel, postTrapNotice } from "../../security/trap-channel.js";
import { trapReadiness } from "../../security/trap-readiness.js";
import { action, channel, choice, group, report, roleList, setting, toggle } from "../registry/builders.js";

const trapAccess = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageMessages,
];

export const security = group("security", [
  // A channel nobody has a reason to post in. Whoever does is a hacked
  // account or a spam bot, and is dealt with without a moderator awake.
  setting("trap", {
    enabled: toggle({
      read: (p) => p.security.trap.enabled,
      write: (v) => ({ trapEnabled: v }),
    }),
    channel: channel({
      textOnly: true,
      clearable: true,
      read: (p) => p.security.trap.channelId,
      write: (v) => ({ trapChannelId: v }),
    }),
    action: choice({
      choices: trapActions,
      read: (p) => p.security.trap.action,
      write: (v) => ({ trapAction: v }),
    }),
    "delete-history": choice({
      choices: trapDeleteWindows,
      read: (p) => p.security.trap.deleteWindow,
      write: (v) => ({ trapDeleteWindow: v }),
    }),
    "timeout-duration": choice({
      choices: trapTimeoutDurations,
      read: (p) => p.security.trap.timeout,
      write: (v) => ({ trapTimeout: v }),
    }),
  }, {
    validate: (patch, context) => {
      const enabled = patch.trapEnabled ?? context.profile.security.trap.enabled;
      const channelId = patch.trapChannelId !== undefined ? patch.trapChannelId : context.profile.security.trap.channelId;
      return enabled && !channelId ? context.error("needs-channel") : null;
    },
  }),

  // Makes a new channel with an ordinary name, and posts the notice in every
  // supported language so no member of any of them posts there by mistake.
  action("create-channel", {
    params: {},
    confirm: true,
    run: async ({ request, text, path }) => {
      const guild = request.guild;
      if (!guild) return { ok: false, message: text.message(path, "no-guild") };
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { ok: false, message: text.message(path, "missing-permission") };
      }
      const created = await createTrapChannel(guild).catch(() => null);
      if (!created) return { ok: false, message: text.message(path, "failed") };
      return { ok: true, message: text.message(path, "done", { channel: `<#${created.id}>` }), patch: { trapChannelId: created.id } };
    },
  }),

  // Uses a channel that already exists instead, and posts the same notice.
  // Run again on the same channel to post the notice again.
  action("use-channel", {
    params: { channel: { kind: "channel", textOnly: true, required: true } },
    run: async ({ request, text, path, values }) => {
      const guild = request.guild;
      const channelId = values.getChannel("channel")?.id;
      if (!guild || !channelId) return { ok: false, message: text.message(path, "missing") };
      const target = guild.channels.cache.get(channelId);
      if (!isPostableTextChannel(target)) return { ok: false, message: text.message(path, "not-text") };
      const me = guild.members.me;
      if (!me || !target.permissionsFor(me).has(trapAccess)) {
        return { ok: false, message: text.message(path, "no-access", { channel: `<#${channelId}>` }) };
      }
      const posted = await postTrapNotice(target).then(() => true, () => false);
      if (!posted) return { ok: false, message: text.message(path, "failed", { channel: `<#${channelId}>` }) };
      return { ok: true, message: text.message(path, "done", { channel: `<#${channelId}>` }), patch: { trapChannelId: channelId } };
    },
  }),

  // Never actioned by any security feature, on top of the owner, bot
  // administrators, bots and anyone holding a staff permission.
  setting("exempt", {
    roles: roleList({
      read: (p) => [...p.security.exemptRoleIds],
      write: (v) => ({ securityExemptRoleIds: [...v] }),
    }),
  }),

  // Where actions are reported. Unset falls back to the audit-log channel.
  setting("log", {
    channel: channel({
      textOnly: true,
      clearable: true,
      read: (p) => p.security.logChannelId,
      write: (v) => ({ securityLogChannelId: v }),
    }),
  }),

  report("status", ({ request, profile, text, path }) => {
    const guild = request.guild;
    if (!guild) return Promise.resolve(text.message(path, "no-guild"));
    const lines = trapReadiness(guild, profile).map((line) => text.message(path, line.name, line.params));
    return Promise.resolve([text.message(path, "heading"), ...lines].join("\n"));
  }),
]);
