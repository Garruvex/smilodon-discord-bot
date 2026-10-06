// What a guild's trap channel does to someone who posts in it. Pure: the
// behavior builds a TrapSubject from the live Discord member and applies the
// decision, so every rule about who is never touched lives here and is tested
// without Discord.

export const trapActions = ["timeout", "kick", "ban"] as const;
export type TrapAction = (typeof trapActions)[number];

// How far back the offender's other messages are swept away. "off" removes
// only the message that tripped the channel.
export const trapDeleteWindows = ["off", "10m", "30m", "1h"] as const;
export type TrapDeleteWindow = (typeof trapDeleteWindows)[number];

// Discord's own ceiling for a timeout is 28 days.
export const trapTimeoutDurations = ["1h", "1d", "7d", "28d"] as const;
export type TrapTimeoutDuration = (typeof trapTimeoutDurations)[number];

export const trapDeleteWindowSeconds: Readonly<Record<TrapDeleteWindow, number>> = {
  "off": 0,
  "10m": 10 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
};

export const trapTimeoutMilliseconds: Readonly<Record<TrapTimeoutDuration, number>> = {
  "1h": 60 * 60 * 1_000,
  "1d": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "28d": 28 * 24 * 60 * 60 * 1_000,
};

export interface TrapConfiguration {
  enabled: boolean;
  channelId: string | null;
  action: TrapAction;
  deleteWindow: TrapDeleteWindow;
  timeout: TrapTimeoutDuration;
}

export interface TrapSubject {
  isBot: boolean;
  isWebhook: boolean;
  isOwner: boolean;
  roleIds: readonly string[];
  // Holds a permission only staff have (Administrator, Manage Server, Ban or
  // Moderate Members, Manage Messages) — a moderator who wanders in is not an
  // intruder, whatever roles the guild has configured.
  hasStaffPermission: boolean;
  botAdministratorRoleIds: readonly string[];
  exemptRoleIds: readonly string[];
  // Whether the bot can do each thing to this member (role order, permission).
  can: Readonly<Record<TrapAction, boolean>>;
}

export type TrapSkipReason = "bot" | "owner" | "bot-administrator" | "exempt-role" | "staff";

export type TrapDecision =
  | { kind: "skip"; reason: TrapSkipReason }
  // The member is fair game but the bot can't touch them (their top role is
  // above the bot's, or the permission is missing). Their message is still
  // removed and the failure is logged.
  | { kind: "blocked"; action: TrapAction }
  | { kind: "act"; action: TrapAction };

export function decideTrapResponse(subject: TrapSubject, trap: Pick<TrapConfiguration, "action">): TrapDecision {
  if (subject.isBot || subject.isWebhook) return { kind: "skip", reason: "bot" };
  if (subject.isOwner) return { kind: "skip", reason: "owner" };
  if (subject.roleIds.some((id) => subject.botAdministratorRoleIds.includes(id))) {
    return { kind: "skip", reason: "bot-administrator" };
  }
  if (subject.roleIds.some((id) => subject.exemptRoleIds.includes(id))) return { kind: "skip", reason: "exempt-role" };
  if (subject.hasStaffPermission) return { kind: "skip", reason: "staff" };
  return subject.can[trap.action] ? { kind: "act", action: trap.action } : { kind: "blocked", action: trap.action };
}
