import { randomUUID } from "node:crypto";

import { isFightingStyle } from "../../../domain/campaign/character/fighting-styles.js";

import { buildProblems, isBuildClass, isBuildRace, kitEquipment, type BuildChoices, type BuildProblem } from "../../../domain/campaign/character/character-build.js";
import { isSkill } from "../../../domain/campaign/character/character-sheet.js";
import { progressionOf, type Progression } from "../../../domain/campaign/character/leveling.js";
import type { UserId } from "../../../domain/campaign/core/ids.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignKey, CampaignTransaction, CampaignUnitOfWork } from "../ports/campaign-store.js";
import type { Clock } from "../ports/clock.js";
import { checkCompatibility, type ImportConflict } from "./compatibility.js";
import type { LibraryCharacter, LibrarySnapshot, PortableCharacter, SnapshotGear } from "./library-types.js";

export const maxCharactersPerOwner = 20;
export const maxImportBytes = 16 * 1024;

export interface CharacterLibraryOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly clock: Clock;
  // The ruleset a new character is built for.
  readonly content: SealedContent;
  readonly rulesetVersion: string;
  readonly newId?: () => string;
}

export type CreateResult =
  | { readonly kind: "ok"; readonly character: LibraryCharacter; readonly snapshot: LibrarySnapshot }
  | { readonly kind: "invalid"; readonly problems: readonly BuildProblem[] }
  | { readonly kind: "full" };

export type EditResult =
  | { readonly kind: "ok"; readonly character: LibraryCharacter; readonly snapshot: LibrarySnapshot }
  | { readonly kind: "invalid"; readonly problems: readonly BuildProblem[] }
  | { readonly kind: "notFound" };

export type ImportResult =
  | { readonly kind: "ok"; readonly character: LibraryCharacter; readonly snapshot: LibrarySnapshot }
  | { readonly kind: "unreadable"; readonly reason: "tooLarge" | "notJson" | "wrongFormat" }
  | { readonly kind: "conflicts"; readonly conflicts: readonly ImportConflict[] }
  | { readonly kind: "full" };

export type SaveProgressResult =
  | { readonly kind: "saved"; readonly snapshot: LibrarySnapshot; readonly created: boolean }
  | { readonly kind: "refused"; readonly reason: "notFound" | "notLibraryHero" | "notYourHero" | "inFight" | "unresolvedChecks" | "characterGone" };

export interface LibraryEntry {
  readonly character: LibraryCharacter;
  readonly snapshots: readonly LibrarySnapshot[];
}

// A player's character library. Every method takes the Discord user ID of
// the person asking and only ever touches that user's characters: a snapshot
// that belongs to someone else reads as missing, so a link or an ID handed
// around gives nobody anything.
export class CharacterLibrary {
  public constructor(private readonly options: CharacterLibraryOptions) {}

  public create(ownerUserId: UserId, build: BuildChoices): Promise<CreateResult> {
    const problems = buildProblems(build);
    if (problems.length > 0) return Promise.resolve({ kind: "invalid", problems });
    return this.options.unitOfWork.transaction((tx) => this.insert(tx, ownerUserId, build, { equipment: kitEquipment(build) }, { kind: "builder" }));
  }

  // An edit is a new version on the main branch. Earlier versions and game copies stay intact.
  public edit(ownerUserId: UserId, characterId: string, build: BuildChoices): Promise<EditResult> {
    const problems = buildProblems(build);
    if (problems.length > 0) return Promise.resolve({ kind: "invalid", problems });
    return this.options.unitOfWork.transaction(async (tx): Promise<EditResult> => {
      const character = await tx.loadLibraryCharacter(characterId);
      if (character === undefined || character.ownerUserId !== ownerUserId) return { kind: "notFound" };
      const snapshots = await tx.listLibrarySnapshots(characterId);
      const parent = snapshots.filter((snapshot) => snapshot.branch === "main").at(-1) ?? snapshots[0];
      if (parent === undefined) return { kind: "notFound" };
      const sameKit = parent.build.class === build.class && parent.build.kit === build.kit && parent.build.race === build.race;
      const updated: LibraryCharacter = { ...character, name: build.name.trim(), className: build.class };
      const snapshot: LibrarySnapshot = {
        id: this.id("ls"), characterId, ownerUserId, revision: snapshots.length + 1, branch: "main", parentSnapshotId: parent.id,
        source: { kind: "edit" }, sourceKey: `edit:${this.id("se")}`,
        rulesetId: this.options.content.rulesetId, rulesetVersion: this.options.rulesetVersion, createdAt: this.options.clock.now(),
        build: { ...build, name: build.name.trim() }, gear: sameKit ? parent.gear : { equipment: kitEquipment(build) },
      };
      await tx.saveLibraryCharacter(updated);
      await tx.saveLibrarySnapshot(snapshot);
      return { kind: "ok", character: updated, snapshot };
    });
  }

  public list(ownerUserId: UserId): Promise<readonly LibraryEntry[]> {
    return this.options.unitOfWork.transaction((tx) => this.listInTransaction(tx, ownerUserId));
  }

  public listInTransaction(tx: CampaignTransaction, ownerUserId: UserId): Promise<readonly LibraryEntry[]> {
    return tx.listLibraryCharacters(ownerUserId).then((characters) =>
      Promise.all(characters.map(async (character) => ({ character, snapshots: await tx.listLibrarySnapshots(character.id) }))),
    );
  }

  public snapshot(ownerUserId: UserId, snapshotId: string): Promise<LibrarySnapshot | undefined> {
    return this.options.unitOfWork.transaction(async (tx) => ownedSnapshot(await tx.loadLibrarySnapshot(snapshotId), ownerUserId));
  }

  public entry(ownerUserId: UserId, characterId: string): Promise<LibraryEntry | undefined> {
    return this.options.unitOfWork.transaction(async (tx) => {
      const character = await tx.loadLibraryCharacter(characterId);
      if (character === undefined || character.ownerUserId !== ownerUserId) return undefined;
      return { character, snapshots: await tx.listLibrarySnapshots(characterId) };
    });
  }

  public gamesForCharacter(ownerUserId: UserId, characterId: string, guildId: string): Promise<readonly { readonly campaignId: string; readonly name: string }[]> {
    return this.options.unitOfWork.transaction(async (tx) => {
      const character = await tx.loadLibraryCharacter(characterId);
      if (character?.ownerUserId !== ownerUserId) return [];
      const records = await tx.listRecords(guildId, ["active", "paused"]);
      const games = await Promise.all(records.map(async ({ record }) => {
        const campaign = await tx.loadCampaign(record.key);
        const heroId = campaign?.state.members[ownerUserId]?.characterId;
        const hero = heroId == null ? undefined : campaign?.state.characters[heroId];
        return hero?.origin?.libraryCharacterId === characterId ? { campaignId: record.key.campaignId, name: record.name } : null;
      }));
      return games.filter((game): game is { campaignId: string; name: string } => game !== null);
    });
  }

  // Deleting is the owner's explicit act. Campaign copies already made are
  // theirs and stay as they are.
  public remove(ownerUserId: UserId, characterId: string): Promise<boolean> {
    return this.options.unitOfWork.transaction(async (tx) => {
      const character = await tx.loadLibraryCharacter(characterId);
      if (character === undefined || character.ownerUserId !== ownerUserId) return false;
      await tx.deleteLibraryCharacter(characterId);
      return true;
    });
  }

  // Saves a hero's progress from a campaign as a new snapshot on that
  // campaign's own branch. Only from a settled moment (no fight, no roll
  // waiting), never HP, spent slots, conditions, the party stash or the
  // party's gold: what carries over is the build, the gear, and the hero's progress (level, XP, classes, improvements).
  public saveProgress(ownerUserId: UserId, key: CampaignKey): Promise<SaveProgressResult> {
    return this.options.unitOfWork.transaction(async (tx): Promise<SaveProgressResult> => {
      const stored = await tx.loadCampaign(key);
      if (stored === undefined) return { kind: "refused", reason: "notFound" };
      const { state } = stored;
      const heroId = state.members[ownerUserId]?.characterId;
      const sheet = heroId === null || heroId === undefined ? undefined : state.characters[heroId];
      if (sheet === undefined || sheet.ownerUserId !== ownerUserId) return { kind: "refused", reason: "notYourHero" };
      if (sheet.origin === undefined) return { kind: "refused", reason: "notLibraryHero" };
      if (state.encounter !== null && state.encounter.status !== "ended") return { kind: "refused", reason: "inFight" };
      if (Object.values(state.checks).some((check) => check.status !== "resolved")) return { kind: "refused", reason: "unresolvedChecks" };

      const parent = await tx.loadLibrarySnapshot(sheet.origin.snapshotId);
      const character = await tx.loadLibraryCharacter(sheet.origin.libraryCharacterId);
      if (parent === undefined || character === undefined || character.ownerUserId !== ownerUserId) return { kind: "refused", reason: "characterGone" };

      const sourceKey = `campaign:${key.campaignId}:${sheet.id}:${stored.revision}`;
      const same = await tx.findLibrarySnapshotBySourceKey(character.id, sourceKey);
      if (same !== undefined) return { kind: "saved", snapshot: same, created: false };

      const existing = await tx.listLibrarySnapshots(character.id);
      const branch = key.campaignId;
      // The line continues from the last snapshot this campaign saved, or from where it began.
      const previous = existing.filter((snapshot) => snapshot.branch === branch).at(-1);
      const gear: SnapshotGear = { equipment: sheet.equipment, ...(sheet.worn === undefined ? {} : { worn: sheet.worn }) };
      const snapshot: LibrarySnapshot = {
        id: this.id("ls"),
        characterId: character.id,
        ownerUserId,
        revision: existing.length + 1,
        branch,
        parentSnapshotId: previous?.id ?? parent.id,
        source: { kind: "campaign", campaignId: key.campaignId, heroId: sheet.id, stateRevision: stored.revision },
        sourceKey,
        rulesetId: parent.rulesetId,
        rulesetVersion: parent.rulesetVersion,
        createdAt: this.options.clock.now(),
        build: parent.build,
        progression: progressionOf(sheet),
        gear,
      };
      await tx.saveLibrarySnapshot(snapshot);
      return { kind: "saved", snapshot, created: true };
    });
  }

  // The file: only choices and gear, never a derived number.
  public export(ownerUserId: UserId, snapshotId: string): Promise<string | undefined> {
    return this.snapshot(ownerUserId, snapshotId).then((snapshot) => {
      if (snapshot === undefined) return undefined;
      const portable: PortableCharacter = { format: "dnd-character", version: 1, rulesetId: snapshot.rulesetId, rulesetVersion: snapshot.rulesetVersion, build: snapshot.build, gear: snapshot.gear, ...(snapshot.progression === undefined ? {} : { progression: snapshot.progression }) };
      return JSON.stringify(portable, null, 2);
    });
  }

  // Reads a file as data: it is parsed, shaped, validated against the ruleset
  // and made a new character owned by the importer. Anything in it that reads
  // like an instruction is just text in the backstory.
  public async import(ownerUserId: UserId, text: string): Promise<ImportResult> {
    if (Buffer.byteLength(text, "utf8") > maxImportBytes) return { kind: "unreadable", reason: "tooLarge" };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: "unreadable", reason: "notJson" };
    }
    const portable = readPortable(raw);
    if (portable === null) return { kind: "unreadable", reason: "wrongFormat" };
    const conflicts = checkCompatibility(portable, this.options.content);
    if (conflicts.length > 0) return { kind: "conflicts", conflicts };
    return this.options.unitOfWork.transaction((tx) => this.insert(tx, ownerUserId, portable.build, portable.gear, { kind: "import" }, portable.rulesetVersion, portable.progression));
  }

  private async insert(
    tx: Parameters<Parameters<CampaignUnitOfWork["transaction"]>[0]>[0],
    ownerUserId: UserId,
    build: BuildChoices,
    gear: SnapshotGear,
    source: LibrarySnapshot["source"],
    rulesetVersion = this.options.rulesetVersion,
    progression?: Progression,
  ): Promise<Extract<CreateResult, { kind: "ok" | "full" }>> {
    if ((await tx.listLibraryCharacters(ownerUserId)).length >= maxCharactersPerOwner) return { kind: "full" };
    const now = this.options.clock.now();
    const character: LibraryCharacter = { id: this.id("lc"), ownerUserId, name: build.name.trim(), className: build.class, createdAt: now };
    const snapshot: LibrarySnapshot = {
      id: this.id("ls"),
      characterId: character.id,
      ownerUserId,
      revision: 1,
      branch: "main",
      parentSnapshotId: null,
      source,
      sourceKey: source.kind,
      rulesetId: this.options.content.rulesetId,
      rulesetVersion,
      createdAt: now,
      build: { ...build, name: build.name.trim() },
      ...(progression === undefined ? {} : { progression }),
      gear,
    };
    await tx.saveLibraryCharacter(character);
    await tx.saveLibrarySnapshot(snapshot);
    return { kind: "ok", character, snapshot };
  }

  private id(prefix: string): string {
    return `${prefix}-${(this.options.newId ?? randomUUID)().replaceAll("-", "").slice(0, 12)}`;
  }
}

function ownedSnapshot(snapshot: LibrarySnapshot | undefined, ownerUserId: UserId): LibrarySnapshot | undefined {
  return snapshot !== undefined && snapshot.ownerUserId === ownerUserId ? snapshot : undefined;
}

// A strict reading of an imported file. Only known keys, only the right types:
// the build is checked for legality separately.
function readPortable(raw: unknown): PortableCharacter | null {
  if (!isRecord(raw) || raw.format !== "dnd-character" || raw.version !== 1) return null;
  if (typeof raw.rulesetId !== "string" || typeof raw.rulesetVersion !== "string") return null;
  const build = readBuild(raw.build);
  const gear = readGear(raw.gear);
  if (build === null || gear === null) return null;
  const progression = raw.progression === undefined ? undefined : readProgression(raw.progression);
  if (progression === null) return null;
  return { format: "dnd-character", version: 1, rulesetId: raw.rulesetId, rulesetVersion: raw.rulesetVersion, build, gear, ...(progression === undefined ? {} : { progression }) };
}

function readBuild(raw: unknown): BuildChoices | null {
  if (!isRecord(raw) || typeof raw.class !== "string" || !isBuildClass(raw.class) || typeof raw.kit !== "string") return null;
  if (typeof raw.name !== "string" || typeof raw.appearance !== "string" || typeof raw.backstory !== "string") return null;
  if (raw.race !== undefined && (typeof raw.race !== "string" || !isBuildRace(raw.race))) return null;
  if (raw.raceAbilityChoices !== undefined && (!Array.isArray(raw.raceAbilityChoices) || raw.raceAbilityChoices.length !== 2 || raw.raceAbilityChoices.some((value: unknown) => typeof value !== "string" || !abilities.includes(value as typeof abilities[number])))) return null;
  if (!isRecord(raw.abilities)) return null;
  const scores: Record<string, number> = {};
  for (const ability of abilities) {
    const score = raw.abilities[ability];
    if (typeof score !== "number" || !Number.isInteger(score)) return null;
    scores[ability] = score;
  }
  const skills = readSkills(raw.skills);
  const expertise = readSkills(raw.expertise);
  const raceSkillChoices = raw.raceSkillChoices === undefined ? undefined : readSkills(raw.raceSkillChoices);
  if (skills === null || expertise === null || raceSkillChoices === null) return null;
  return {
    class: raw.class,
    kit: raw.kit,
    abilities: scores as BuildChoices["abilities"],
    skills,
    expertise,
    name: raw.name,
    appearance: raw.appearance,
    backstory: raw.backstory,
    ...(raw.race === undefined ? {} : { race: raw.race }),
    ...(raw.raceAbilityChoices === undefined ? {} : { raceAbilityChoices: raw.raceAbilityChoices as readonly (typeof abilities)[number][] }),
    ...(raceSkillChoices === undefined ? {} : { raceSkillChoices }),
  };
}

function readSkills(raw: unknown): BuildChoices["skills"] | null {
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const skills: BuildChoices["skills"][number][] = [];
  for (const value of raw as unknown[]) {
    if (typeof value !== "string" || !isSkill(value)) return null;
    skills.push(value);
  }
  return skills;
}

function readGear(raw: unknown): SnapshotGear | null {
  if (!isRecord(raw) || !isItemList(raw.equipment)) return null;
  if (raw.worn === undefined) return { equipment: raw.equipment };
  return isItemList(raw.worn) ? { equipment: raw.equipment, worn: raw.worn } : null;
}

function isItemList(value: unknown): value is SnapshotGear["equipment"] {
  return Array.isArray(value) && value.length <= 30 && value.every((entry) => typeof entry === "string" && /^item:[a-z0-9-]+$/.test(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Numbers only, and only known keys: whether they add up to a legal hero is
// checked separately (compatibility.ts), like a build's.
function readProgression(raw: unknown): Progression | null {
  if (!isRecord(raw) || typeof raw.xp !== "number" || typeof raw.pendingAsi !== "number") return null;
  if (!isRecord(raw.classLevels) || !isRecord(raw.multiclassSkills) || !isRecord(raw.abilityScores)) return null;
  if (Object.keys(raw.classLevels).length > 12 || Object.keys(raw.multiclassSkills).length > 12) return null;
  const classLevels: Record<string, number> = {};
  for (const [name, count] of Object.entries(raw.classLevels)) {
    if (typeof count !== "number") return null;
    classLevels[name] = count;
  }
  const multiclassSkills: Record<string, BuildChoices["skills"][number]> = {};
  for (const [name, skill] of Object.entries(raw.multiclassSkills)) {
    if (typeof skill !== "string" || !isSkill(skill)) return null;
    multiclassSkills[name] = skill;
  }
  const scores: Record<string, number> = {};
  for (const ability of abilities) {
    const score = raw.abilityScores[ability];
    if (typeof score !== "number") return null;
    scores[ability] = score;
  }
  const style = typeof raw.fightingStyle === "string" && isFightingStyle(raw.fightingStyle) ? raw.fightingStyle : undefined;
  return { xp: raw.xp, classLevels, multiclassSkills, abilityScores: scores as Progression["abilityScores"], pendingAsi: raw.pendingAsi, ...(style === undefined ? {} : { fightingStyle: style }) };
}
