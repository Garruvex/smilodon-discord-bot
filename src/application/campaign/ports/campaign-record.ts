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

export type PacingPresetId = "live" | "playByPost" | "custom";

// Discord places, filled in as setup creates them (all null until then).
export interface CampaignChannels {
  readonly categoryId: string | null;
  readonly partyChannelId: string | null;
  readonly adventureChannelId: string | null;
  readonly discussionThreadId: string | null;
  readonly roleId: string | null;
}

// A Discord resource a game needs. It is written down, with the name chosen
// for it, before any Discord call and its ID is filled in right after the
// create, so a retry resumes instead of duplicating, and a later repair
// recreates a deleted channel under the same name. Entries stay for the life
// of the campaign; a null ID means not created yet.
export interface PendingResource {
  readonly kind: "partyChannel" | "adventureChannel" | "discussionThread" | "role";
  // A marker written into the resource's topic so a leftover from an
  // uncertain send can be found again.
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
  // The hub's one message listing every game.
  readonly hubCard: CardReference | null;
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
}

export interface StoredRecord {
  readonly record: CampaignRecord;
  // The compare-and-set point for the record, separate from the engine state's.
  readonly revision: number;
}

export const emptyChannels: CampaignChannels = {
  categoryId: null,
  partyChannelId: null,
  adventureChannelId: null,
  discussionThreadId: null,
  roleId: null,
};
