import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { AdventureLibrary, AdventureSummary } from "../ports/adventure-library.js";
import type { AdventureDocument } from "./adventure-document.js";

export interface LibraryEntry {
  readonly id: string;
  readonly editions: Readonly<Partial<Record<CampaignLanguage, AdventureDocument>>>;
}

// An in-memory library of already validated adventures.
export class StaticAdventureLibrary implements AdventureLibrary {
  private readonly entries = new Map<string, LibraryEntry>();

  public constructor(entries: readonly LibraryEntry[]) {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }

  public list(): readonly AdventureSummary[] {
    return [...this.entries.values()].flatMap((entry) => {
      const documents = Object.entries(entry.editions) as [CampaignLanguage, AdventureDocument][];
      const first = documents[0]?.[1];
      if (first === undefined) return [];
      return [
        {
          id: entry.id,
          version: first.bible.version,
          languages: documents.map(([language]) => language),
          titles: Object.fromEntries(documents.map(([language, document]) => [language, document.bible.title])),
          heroes: first.heroes.map((hero) => ({ id: hero.id, name: hero.name, class: hero.class })),
        },
      ];
    });
  }

  public document(adventureId: string, language: CampaignLanguage): AdventureDocument | undefined {
    return this.entries.get(adventureId)?.editions[language];
  }

  public find(adventureId: string, version: string, language: CampaignLanguage): AdventureDocument["bible"] | undefined {
    const bible = this.document(adventureId, language)?.bible;
    return bible?.version === version ? bible : undefined;
  }
}
