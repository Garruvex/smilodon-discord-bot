import { createHash } from "node:crypto";

import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Instant } from "../../../domain/campaign/core/ids.js";

// An adventure a server's people brought: uploaded as a file or written by the
// Adventure Author. It waits for its uploader's approval, and only an approved
// one can start a game. The text kept is the validated, canonical document
// (one language edition), with the adventure's ID made unique to the server.
// removed: taken out of the library; new games no longer offer it, but games and lobbies that already use it keep it.
export type AdventureStatus = "pending" | "approved" | "discarded" | "removed";

// One row per language edition: "en:g1a2b3c-harbor-heist:1".
export function adventureKey(id: string, version: string, language: CampaignLanguage): string {
  return `${language}:${id}:${version}`;
}

// A short fingerprint of the text a draft holds. A review names it, so a decision only lands on the draft that was read.
export function revisionOf(adventure: Pick<StoredAdventure, "yaml">): string {
  return createHash("sha1").update(adventure.yaml).digest("hex").slice(0, 8);
}

export interface StoredAdventure {
  // The row's key (see adventureKey): what an approval button names.
  readonly key: string;
  // The document's own (namespaced) ID: what a campaign pins.
  readonly id: string;
  readonly guildId: string;
  readonly version: string;
  readonly uploaderUserId: string;
  readonly status: AdventureStatus;
  readonly source: "upload" | "author";
  readonly language: CampaignLanguage;
  readonly title: string;
  readonly yaml: string;
  readonly warnings: readonly string[];
  readonly createdAt: Instant;
}
