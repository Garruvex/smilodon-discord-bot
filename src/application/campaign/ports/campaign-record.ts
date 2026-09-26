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

// A Discord resource setup started to create. Saved before the call and
// resolved after it, so a retry resumes instead of duplicating.
export interface PendingResource {
  readonly kind: "partyChannel" | "adventureChannel" | "discussionThread" | "role";
  // A marker written into the resource's name or topic so a leftover from an
  // uncertain send can be found again.
  readonly marker: string;
  readonly resourceId: string | null;
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
