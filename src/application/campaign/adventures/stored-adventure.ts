import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Instant } from "../../../domain/campaign/core/ids.js";

// An adventure a server's people brought: uploaded as a file or written by the
// Adventure Author. It waits for its uploader's approval, and only an approved
// one can start a game. The text kept is the validated, canonical document
// (one language edition), with the adventure's ID made unique to the server.
export type AdventureStatus = "pending" | "approved" | "discarded";

// One row per language edition: "en:g1a2b3c-harbor-heist:1".
export function adventureKey(id: string, version: string, language: CampaignLanguage): string {
  return `${language}:${id}:${version}`;
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
