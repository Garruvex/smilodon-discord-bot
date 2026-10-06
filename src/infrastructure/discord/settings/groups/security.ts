import { PermissionFlagsBits } from "discord.js";

import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import {
  linkActions,
  maxDomainListText,
  maxListedDomains,
  raidAccountAgeLimits,
  raidActions,
  raidJoinLimits,
  securityWindows,
  spamChannelLimits,
} from "../../../../domain/security/detection-policy.js";
import { parseDomainList, type DomainListResult } from "../../../../domain/security/link-inspection.js";
import {
  trapActions,
  trapDeleteWindows,
  trapTimeoutDurations,
} from "../../../../domain/security/trap-policy.js";
import { createTrapChannel, isPostableTextChannel, postTrapNotice } from "../../security/trap-channel.js";
import { trapReadiness } from "../../security/trap-readiness.js";
import { action, channel, choice, group, integer, report, roleList, setting, text, toggle } from "../registry/builders.js";
import type { Patch, TextOption } from "../registry/types.js";

const trapAccess = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageMessages,
];

// A list of domains typed as text, because a domain isn't something the panel
// can pick from a menu. "none" empties it, since a blank field means "leave
// as it is".
function domainsFromText(value: string): DomainListResult {
  return /^(?:none|clear|-)$/i.test(value.trim()) ? { domains: [], invalid: [] } : parseDomainList(value);
}

const domainList = (
  read: (profile: GuildConfiguration) => readonly string[],
  write: (domains: readonly string[]) => Patch,
): TextOption => text({
  maxLength: maxDomainListText,
  read: (p) => read(p).join(", "),
  write: (v) => write(domainsFromText(v).domains),
  validate: (v, context) => {
    const { domains, invalid } = domainsFromText(v);
    if (invalid.length > 0) return context.error("invalid", { entry: invalid[0] ?? "" });
    return domains.length > maxListedDomains ? context.error("too-many", { max: maxListedDomains }) : null;
  },
});

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

  // The same message in several channels in moments: what a hacked account
  // does. Judged by repetition alone, so it works in any language.
  setting("spam", {
    enabled: toggle({
      read: (p) => p.security.spam.enabled,
      write: (v) => ({ spamEnabled: v }),
    }),
    channels: integer({
      min: spamChannelLimits.min,
      max: spamChannelLimits.max,
      read: (p) => p.security.spam.channels,
      write: (v) => ({ spamChannels: v }),
    }),
    window: choice({
      choices: securityWindows,
      read: (p) => p.security.spam.window,
      write: (v) => ({ spamWindow: v }),
    }),
    action: choice({
      choices: trapActions,
      read: (p) => p.security.spam.action,
      write: (v) => ({ spamAction: v }),
    }),
    "delete-history": choice({
      choices: trapDeleteWindows,
      read: (p) => p.security.spam.deleteWindow,
      write: (v) => ({ spamDeleteWindow: v }),
    }),
    "timeout-duration": choice({
      choices: trapTimeoutDurations,
      read: (p) => p.security.spam.timeout,
      write: (v) => ({ spamTimeout: v }),
    }),
  }),

  // Links to sites the server has blocked, lookalikes of well-known brands,
  // and (if asked) invites to other servers. Judged by name; never fetched.
  setting("links", {
    enabled: toggle({
      read: (p) => p.security.links.enabled,
      write: (v) => ({ linksEnabled: v }),
    }),
    action: choice({
      choices: linkActions,
      read: (p) => p.security.links.action,
      write: (v) => ({ linksAction: v }),
    }),
    "delete-history": choice({
      choices: trapDeleteWindows,
      read: (p) => p.security.links.deleteWindow,
      write: (v) => ({ linksDeleteWindow: v }),
    }),
    "timeout-duration": choice({
      choices: trapTimeoutDurations,
      read: (p) => p.security.links.timeout,
      write: (v) => ({ linksTimeout: v }),
    }),
    "blocked-domains": domainList(
      (p) => p.security.links.blockedDomains,
      (domains) => ({ linksBlockedDomains: domains }),
    ),
    "allowed-domains": domainList(
      (p) => p.security.links.allowedDomains,
      (domains) => ({ linksAllowedDomains: domains }),
    ),
    suspicious: toggle({
      read: (p) => p.security.links.suspicious,
      write: (v) => ({ linksSuspicious: v }),
    }),
    invites: toggle({
      read: (p) => p.security.links.invites,
      write: (v) => ({ linksInvites: v }),
    }),
  }),

  // Many accounts joining at once. Tells staff, and can deal with the
  // joiners too.
  setting("raid", {
    enabled: toggle({
      read: (p) => p.security.raid.enabled,
      write: (v) => ({ raidEnabled: v }),
    }),
    joins: integer({
      min: raidJoinLimits.min,
      max: raidJoinLimits.max,
      read: (p) => p.security.raid.joins,
      write: (v) => ({ raidJoins: v }),
    }),
    window: choice({
      choices: securityWindows,
      read: (p) => p.security.raid.window,
      write: (v) => ({ raidWindow: v }),
    }),
    action: choice({
      choices: raidActions,
      read: (p) => p.security.raid.action,
      write: (v) => ({ raidAction: v }),
    }),
    "account-age-days": integer({
      min: raidAccountAgeLimits.min,
      max: raidAccountAgeLimits.max,
      read: (p) => p.security.raid.accountAgeDays,
      write: (v) => ({ raidAccountAgeDays: v }),
    }),
    "timeout-duration": choice({
      choices: trapTimeoutDurations,
      read: (p) => p.security.raid.timeout,
      write: (v) => ({ raidTimeout: v }),
    }),
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
