import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Instant, UserId } from "../../../domain/campaign/core/ids.js";
import type { LobbyState } from "../../../domain/campaign/lobby/lobby.js";
import type { Pacing } from "../../../domain/campaign/state/campaign-state.js";
import type { AdventurePin, CampaignKey } from "./campaign-store.js";

// The campaign as the server knows it: who runs it, what it is, where it
// lives on Discord, and how far along it is. The engine's CampaignState only
// exists once the campaign starts; before that the lobby lives here.

// lobby: players are joining. active: playing. paused: the organizer paused it,
// or a restart is waiting for recovery. archived: finished; read-only.
export type CampaignLifecycle = "lobby" | "active" | "paused" | "archived";

// Who can see a game's channels once it starts: anyone who can see the D&D
// category (open), or only the players and whoever the organizer adds to the
// game's role (membersOnly). Games saved before this existed are open.
export type CampaignVisibility = "open" | "membersOnly";

export type PacingPresetId = "live" | "playByPost" | "custom";

// Discord places, filled in as setup creates them (all null until then).
// partyPostId/adventurePostId are forum posts (one Parties post, one Games
// post), each in the public or private forum pair chosen by the campaign's
// visibility at creation. Players talk directly in the party post's own
// thread; there is no separate Table Talk thread any more. There is no
// per-campaign role either: a membersOnly campaign's players are granted the
// guild's one shared private-games role (GuildCampaignSettings.privateGamesRoleId)
// instead, since a forum post cannot be restricted independently of its forum.
export interface CampaignChannels {
  readonly categoryId: string | null;
  readonly partyPostId: string | null;
  readonly adventurePostId: string | null;
}

// A Discord resource a game needs. It is written down, with the name chosen
// for it, before any Discord call and its ID is filled in right after the
// create, so a retry resumes instead of duplicating, and a later repair
// recreates a deleted post under the same name. Entries stay for the life
// of the campaign; a null ID means not created yet.
export interface PendingResource {
  readonly kind: "partyPost" | "adventurePost";
  // A marker carried in the resource's topic (a text channel) or starter
  // message (a forum post) so a leftover from an uncertain send can be found
  // again.
  readonly marker: string;
  readonly name: string;
  readonly resourceId: string | null;
}

// A logical card (or panel) and the Discord message that currently shows it.
// Controls from any other message are obsolete and refused (panel spec,
// Update, replacement, and restart contract).
export interface CardReference {
  readonly channelId: string;
  readonly messageId: string;
  // A fingerprint of what was last drawn, so an unchanged card is not re-sent.
  readonly renderedHash: string;
  // Which round or turn the message belongs to. A card whose epoch changes is
  // replaced by a new message (the old one is retired) instead of edited.
  readonly epoch: string;
}

// The server-wide campaign setup (/dnd setup): where games live and where the
// hub lists them. Bot-managed identifiers, so they are kept here and never
// written back into the human-managed guild profile.
export interface GuildCampaignSettings {
  readonly guildId: string;
  readonly categoryId: string | null;
  readonly hubChannelId: string | null;
  // The four forums a campaign's Games/Parties posts go into, chosen by
  // visibility at creation. Settings saved before these existed have no
  // value, read as null (an old-style setup awaiting a repeat /dnd setup).
  readonly publicGamesForumId?: string | null;
  readonly publicPartiesForumId?: string | null;
  readonly privateGamesForumId?: string | null;
  readonly privatePartiesForumId?: string | null;
  // The hub's pinned control message (Create game). Each game's own hub
  // message is the "hub" card on its record.
  readonly hubCard: CardReference | null;
  // The "DnD Admin" role: its holders can create and manage every game.
  // Settings saved before the role existed have no value, read as null.
  readonly adminRoleId?: string | null;
  // Shared by every membersOnly campaign: what the Private Games/Parties
  // forums are restricted to, and what a private campaign's own players are
  // granted so they can see their game (plan §1's "Private-games role").
  readonly privateGamesRoleId?: string | null;
}

// Something the organizer has to fix. deliveryFailed: a message was given up
// on after many tries. cardsFailed: a card could not be drawn. permissions: the
// bot lacks a permission it needs. channelMissing: a channel is gone and was
// not (or could not be) made again.
export type CampaignIssueCode = "deliveryFailed" | "cardsFailed" | "permissions" | "channelMissing";

export interface CampaignIssue {
  readonly code: CampaignIssueCode;
  // What exactly: a delivery kind, card names, or permission names.
  readonly detail: string;
  readonly since: Instant;
  // The organizer has been told (once, in the game's channel).
  readonly notified: boolean;
}

export interface CampaignRecord {
  readonly key: CampaignKey;
  readonly name: string;
  readonly organizerId: UserId;
  readonly language: CampaignLanguage;
  readonly lifecycle: CampaignLifecycle;
  readonly adventure: AdventurePin;
  readonly pacingPreset: PacingPresetId;
  readonly pacing: Pacing;
  // Expanded house-rule values chosen at setup.
  readonly houseRules: Readonly<Record<string, string>>;
  readonly lobby: LobbyState;
  readonly channels: CampaignChannels;
  readonly pendingResources: readonly PendingResource[];
  // Logical card key ("lobby", "party", "hero:<id>", "adventure", "hub") to its message.
  readonly cards: Readonly<Record<string, CardReference>>;
  readonly createdAt: Instant;
  readonly startedAt: Instant | null;
  // Problems waiting for the organizer; records saved before this existed have none.
  readonly issues?: readonly CampaignIssue[];
  readonly visibility?: CampaignVisibility;
  // What became of each scene's picture, and how much of the picture budget is spent.
  readonly images?: Readonly<Record<string, "made" | "done" | "skipped" | "failed">>;
  readonly imageBudget?: { readonly limit: number; readonly used: number };
  // The subject of the picture posted last, which the organizer's Redo repaints.
  readonly lastPicture?: string;
}

export interface StoredRecord {
  readonly record: CampaignRecord;
  // The compare-and-set point for the record, separate from the engine state's.
  readonly revision: number;
}

export const emptyChannels: CampaignChannels = {
  categoryId: null,
  partyPostId: null,
  adventurePostId: null,
};
