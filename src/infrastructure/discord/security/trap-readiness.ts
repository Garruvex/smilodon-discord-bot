import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";

import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { TrapAction } from "../../../domain/security/trap-policy.js";

// One line of the security status: the name of a message in the status
// report's text, and what fills its placeholders.
export interface ReadinessLine {
  name: string;
  params?: Readonly<Record<string, string | number>>;
}

const actionPermission: Readonly<Record<TrapAction, { flag: bigint; label: string }>> = {
  timeout: { flag: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  kick: { flag: PermissionFlagsBits.KickMembers, label: "Kick Members" },
  ban: { flag: PermissionFlagsBits.BanMembers, label: "Ban Members" },
};

// What would stop the trap channel from working right now: the checks an
// admin would otherwise only learn about the first time it fails to catch
// someone. Ordered as the report shows them.
export function trapReadiness(guild: Guild, profile: GuildConfiguration): ReadinessLine[] {
  const trap = profile.security.trap;
  const lines: ReadinessLine[] = [{ name: trap.enabled ? "on" : "off" }];
  const me = guild.members.me;

  if (!trap.channelId) {
    lines.push({ name: "no-channel" });
  } else {
    const channel = guild.channels.cache.get(trap.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      lines.push({ name: "channel-missing" });
    } else {
      const mention = `<#${channel.id}>`;
      lines.push({ name: "channel", params: { channel: mention } });
      const everyone = channel.permissionsFor(guild.roles.everyone);
      if (!everyone.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        lines.push({ name: "everyone-cannot-post", params: { channel: mention } });
      }
      if (me && !channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
        lines.push({ name: "bot-no-access", params: { channel: mention } });
      }
    }
  }

  if (me) {
    const needed = actionPermission[trap.action];
    if (!me.permissions.has(needed.flag)) {
      lines.push({ name: "missing-permission", params: { permission: needed.label, action: trap.action } });
    }
    if (trap.action !== "ban" && trap.deleteWindow !== "off" && !me.permissions.has(PermissionFlagsBits.ManageMessages)) {
      lines.push({ name: "missing-sweep-permission" });
    }
  }

  // The other detectors need the permission for what they do, too.
  if (me) {
    const { spam, links, raid } = profile.security;
    const needs = (action: TrapAction): void => {
      const permission = actionPermission[action];
      if (!me.permissions.has(permission.flag)) {
        lines.push({ name: "missing-permission", params: { permission: permission.label, action } });
      }
    };
    if (spam.enabled) {
      needs(spam.action);
      if (!me.permissions.has(PermissionFlagsBits.ManageMessages)) lines.push({ name: "spam-missing-delete" });
    }
    if (links.enabled) {
      if (links.action !== "delete") needs(links.action);
      if (!me.permissions.has(PermissionFlagsBits.ManageMessages)) lines.push({ name: "links-missing-delete" });
    }
    if (raid.enabled && raid.action !== "alert") needs(raid.action);
  }

  const logChannelId = profile.security.logChannelId ?? profile.channels.auditLog;
  if (!logChannelId) {
    lines.push({ name: "no-log" });
  } else {
    const log = guild.channels.cache.get(logChannelId);
    const canSend = log?.isTextBased() === true && me !== null && log.permissionsFor(me)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ]) === true;
    lines.push(canSend ? { name: "log", params: { channel: `<#${logChannelId}>` } } : { name: "log-unavailable" });
  }
  return lines;
}
