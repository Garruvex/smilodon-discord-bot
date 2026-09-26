import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { AdventureLibrary, AdventureSummary } from "../ports/adventure-library.js";
import type { AdventureDocument } from "./adventure-document.js";

interface Uploaded {
  readonly guildId: string;
  readonly document: AdventureDocument;
}

// The bundled adventures plus every approved upload. Uploads are kept in memory
// (loaded at startup, added on approval): the bot is one process, and the
// lookups the DM makes while a game runs are synchronous. An adventure's ID is
// unique to the server that made it, and a game pins the version it started
// with, so approving a newer version never changes a running game.
export class UploadedAdventureLibrary implements AdventureLibrary {
  // adventure ID -> version -> language edition
  private readonly uploads = new Map<string, Map<string, Map<CampaignLanguage, Uploaded>>>();

  public constructor(private readonly base: AdventureLibrary) {}

  public add(guildId: string, document: AdventureDocument): void {
    const { id, version, language } = document.bible;
    const versions = this.uploads.get(id) ?? new Map<string, Map<CampaignLanguage, Uploaded>>();
    const editions = versions.get(version) ?? new Map<CampaignLanguage, Uploaded>();
    editions.set(language, { guildId, document });
    versions.set(version, editions);
    this.uploads.set(id, versions);
  }

  public list(): readonly AdventureSummary[] {
    return [...this.base.list(), ...[...this.uploads.keys()].flatMap((id) => this.summaryOf(id))];
  }

  // What a server may start a game from: the bundled adventures and its own approved ones.
  public listForGuild(guildId: string): readonly AdventureSummary[] {
    return [...this.base.list(), ...[...this.uploads.keys()].filter((id) => this.guildOf(id) === guildId).flatMap((id) => this.summaryOf(id))];
  }

  // The server an uploaded adventure belongs to; null for a bundled one.
  public guildOf(adventureId: string): string | null {
    const versions = this.uploads.get(adventureId);
    const first = versions === undefined ? undefined : [...versions.values()][0];
    return first === undefined ? null : ([...first.values()][0]?.guildId ?? null);
  }

  public document(adventureId: string, language: CampaignLanguage): AdventureDocument | undefined {
    const latest = this.latest(adventureId);
    return latest?.get(language)?.document ?? this.base.document(adventureId, language);
  }

  public find(adventureId: string, version: string, language: CampaignLanguage): AdventureDocument["bible"] | undefined {
    return this.uploads.get(adventureId)?.get(version)?.get(language)?.document.bible ?? this.base.find(adventureId, version, language);
  }

  private latest(adventureId: string): Map<CampaignLanguage, Uploaded> | undefined {
    const versions = this.uploads.get(adventureId);
    if (versions === undefined) return undefined;
    // Versions are compared as text, then by how recently they were added: the last added wins.
    return [...versions.values()].at(-1);
  }

  private summaryOf(adventureId: string): readonly AdventureSummary[] {
    const editions = this.latest(adventureId);
    const entries = editions === undefined ? [] : ([...editions.entries()] as [CampaignLanguage, Uploaded][]);
    const first = entries[0]?.[1].document;
    if (first === undefined) return [];
    return [
      {
        id: adventureId,
        version: first.bible.version,
        languages: entries.map(([language]) => language),
        titles: Object.fromEntries(entries.map(([language, uploaded]) => [language, uploaded.document.bible.title])),
        heroes: first.heroes.map((hero) => ({ id: hero.id, name: hero.name, class: hero.class })),
      },
    ];
  }
}
