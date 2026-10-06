import { trapActions, type TrapAction, type TrapDeleteWindow, type TrapTimeoutDuration } from "./trap-policy.js";

// The settings shared by the detectors that watch behavior rather than a
// bait channel: cross-channel spam, risky links, and join raids. Each answers
// "what counts" and "what happens", and what happens reuses the trap's
// actions (time out, kick, ban) so one staff-exemption rule covers them all.

// How far back a detector looks.
export const securityWindows = ["10s", "30s", "1m", "5m"] as const;
export type SecurityWindow = (typeof securityWindows)[number];

export const securityWindowMilliseconds: Readonly<Record<SecurityWindow, number>> = {
  "10s": 10_000,
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
};

export const spamChannelLimits = { min: 2, max: 10, default: 3 } as const;
export const raidJoinLimits = { min: 3, max: 50, default: 10 } as const;
// 0 turns the account-age check off.
export const raidAccountAgeLimits = { min: 0, max: 30, default: 0 } as const;

// Removing the message alone is the gentlest response to a link.
export const linkActions = ["delete", ...trapActions] as const;
export type LinkAction = (typeof linkActions)[number];

// Telling staff, without touching the joiners, is the gentlest to a raid.
export const raidActions = ["alert", ...trapActions] as const;
export type RaidAction = (typeof raidActions)[number];

export interface SpamConfiguration {
  enabled: boolean;
  // The same message in this many different channels within the window.
  channels: number;
  window: SecurityWindow;
  action: TrapAction;
  deleteWindow: TrapDeleteWindow;
  timeout: TrapTimeoutDuration;
}

export interface LinkConfiguration {
  enabled: boolean;
  action: LinkAction;
  deleteWindow: TrapDeleteWindow;
  timeout: TrapTimeoutDuration;
  // Hosts (and their subdomains) that are always refused.
  blockedDomains: readonly string[];
  // Hosts (and their subdomains) that are never refused, whatever else says.
  allowedDomains: readonly string[];
  // Lookalikes of well-known brands, punycode hosts and raw IP addresses.
  suspicious: boolean;
  // Invites to other Discord servers.
  invites: boolean;
}

export interface RaidConfiguration {
  enabled: boolean;
  // This many joins within the window is a raid.
  joins: number;
  window: SecurityWindow;
  action: RaidAction;
  // With a number above 0, only accounts younger than this many days are
  // actioned; the alert still counts everyone. 0 actions every joiner.
  accountAgeDays: number;
  timeout: TrapTimeoutDuration;
}

export const maxListedDomains = 50;
export const maxDomainListText = 1_500;
