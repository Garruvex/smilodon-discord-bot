import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AdventureDocumentError,
  checkEditionsMatch,
  parseAdventureDocument,
  type AdventureDocument,
} from "../../application/campaign/adventures/adventure-document.js";
import type { CampaignLanguage } from "../../domain/campaign/adventure/adventure-bible.js";

export const starterAdventureId = "moonlit-ruins";
const editions: readonly CampaignLanguage[] = ["en", "zh-TW"];

// Loads every language edition of the bundled starter adventure from
// assets/, and refuses editions that disagree on structure.
export function loadStarterAdventure(): Readonly<Record<CampaignLanguage, AdventureDocument>> {
  const documents = editions.map((language) => {
    const url = new URL(`../../../assets/campaign/adventures/${starterAdventureId}/${language}.yaml`, import.meta.url);
    const document = parseAdventureDocument(readFileSync(fileURLToPath(url), "utf8"));
    if (document.bible.language !== language) {
      throw new AdventureDocumentError([`${language}.yaml declares language ${document.bible.language}.`]);
    }
    return document;
  });
  const mismatches = checkEditionsMatch(documents);
  if (mismatches.length > 0) throw new AdventureDocumentError(mismatches);
  const [en, zhTw] = documents as [AdventureDocument, AdventureDocument];
  return { en, "zh-TW": zhTw };
}
