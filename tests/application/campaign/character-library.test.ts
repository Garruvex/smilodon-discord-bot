import { describe, expect, it } from "vitest";

import { CampaignLobbyService } from "../../../src/application/campaign/campaign-lobby-service.js";
import { instantiateHero } from "../../../src/application/campaign/library/instantiate.js";
import { levelUp } from "../../../src/domain/campaign/character/leveling.js";
import { CharacterLibrary } from "../../../src/application/campaign/library/character-library.js";
import { libraryHeroRef, type LibrarySnapshot } from "../../../src/application/campaign/library/library-types.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { encounterSpec, findEncounter } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";
import { guildId, rig, starter, tellOpening, type Rig } from "./campaign-rig.js";

const aldric: BuildChoices = {
  class: "fighter",
  kit: "knight",
  abilities: { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 },
  skills: ["athletics", "perception"],
  expertise: [],
  name: "Aldric",
  appearance: "Broad and scarred.",
  backstory: "A former town guard.",
};

interface Table {
  r: Rig;
  library: CharacterLibrary;
  lobby: CampaignLobbyService;
}

function table(): Table {
  const r = rig();
  const content = ruleset().content;
  const library = new CharacterLibrary({ unitOfWork: r.store, clock: r.clock, content, rulesetVersion: content.version });
  const lobby = new CampaignLobbyService({
    unitOfWork: r.store,
    bus: r.bus,
    adventures: r.adventures,
    clock: r.clock,
    ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    library,
    rulesets: r.rulesets,
  });
  return { r, library, lobby };
}

async function newLobby(t: Table, houseRules: Record<string, string> = {}, name = "Moonlit Ruins"): Promise<CampaignKey> {
  const created = await t.lobby.create({ guildId, organizerId: "u-alice", name, language: "en", adventureId: starterAdventureId, pacing: { preset: "live" }, houseRules });
  if (created.kind !== "ok") throw new Error("create");
  return created.value.key;
}

async function createAldric(t: Table, owner = "u-alice"): Promise<LibrarySnapshot> {
  const made = await t.library.create(owner, aldric);
  if (made.kind !== "ok") throw new Error(`create: ${made.kind}`);
  return made.snapshot;
}

// The player joins the lobby with the saved character, and the game starts and opens its first round.
async function play(t: Table, key: CampaignKey, snapshot: LibrarySnapshot, userId = "u-alice"): Promise<CampaignState> {
  await t.lobby.join(key, userId);
  expect(await t.lobby.chooseSaved(key, userId, snapshot.id)).toMatchObject({ kind: "ok" });
  const started = await t.lobby.start(key, "u-alice");
  if (started.kind !== "ok") throw new Error(`start: ${JSON.stringify(started)}`);
  await tellOpening(t.r, key);
  return stateOf(t.r, key);
}

const stateOf = async (r: Rig, key: CampaignKey): Promise<CampaignState> => {
  const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
  if (stored === undefined) throw new Error("state");
  return stored.state;
};
const heroOf = (state: CampaignState, userId = "u-alice"): NonNullable<CampaignState["characters"][string]> => {
  const id = state.members[userId]?.characterId ?? "";
  const hero = state.characters[id];
  if (hero === undefined) throw new Error("hero");
  return hero;
};
const actor = { kind: "user", userId: "u-alice" } as const;

describe("the character library", () => {
  it("keeps a character for its owner alone, across everything a link or an ID could reveal", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    expect(snapshot).toMatchObject({ revision: 1, branch: "main", parentSnapshotId: null, ownerUserId: "u-alice", gear: { equipment: ["item:longsword", "item:chain-mail", "item:shield"] } });
    expect((await t.library.list("u-alice")).map((entry) => entry.character.name)).toEqual(["Aldric"]);
    // Anyone else sees nothing: not the list, the snapshot, the export, or a way to remove it.
    expect(await t.library.list("u-bob")).toEqual([]);
    expect(await t.library.snapshot("u-bob", snapshot.id)).toBeUndefined();
    expect(await t.library.export("u-bob", snapshot.id)).toBeUndefined();
    expect(await t.library.remove("u-bob", snapshot.characterId)).toBe(false);
    expect(await t.library.entry("u-bob", snapshot.characterId)).toBeUndefined();
    expect(await t.library.snapshot("u-alice", snapshot.id)).toEqual(snapshot);
  });

  it("refuses an illegal build with the reasons, and stops at twenty characters", async () => {
    const t = table();
    expect(await t.library.create("u-alice", { ...aldric, abilities: { ...aldric.abilities, str: 18 } })).toEqual({ kind: "invalid", problems: [{ code: "abilitiesNotStandardArray" }] });
    for (let index = 0; index < 20; index += 1) await createAldric(t);
    expect(await t.library.create("u-alice", aldric)).toEqual({ kind: "full" });
    // Another player's shelf is their own.
    expect((await t.library.create("u-bob", aldric)).kind).toBe("ok");
  });

  it("deletes a character and its snapshots on the owner's say, leaving campaign copies alone", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    const state = await play(t, key, snapshot);
    expect(await t.library.remove("u-alice", snapshot.characterId)).toBe(true);
    expect(await t.library.list("u-alice")).toEqual([]);
    expect(await t.library.snapshot("u-alice", snapshot.id)).toBeUndefined();
    // The game in progress still has its hero.
    expect(heroOf(await stateOf(t.r, key)).name).toBe(heroOf(state).name);
  });
});

describe("bringing a saved character into a game", () => {
  it("previews what carries over, then seats the character and shows it on the lobby", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    await t.lobby.join(key, "u-alice");
    const preview = await t.lobby.previewSaved(key, "u-alice", snapshot.id);
    if (preview.kind !== "ok") throw new Error("preview");
    expect(preview.conflicts).toEqual([]);
    expect(preview.hero).toMatchObject({ name: "Aldric", maxHp: 12, level: 1, equipment: ["item:longsword", "item:chain-mail", "item:shield"] });
    // Looking seats nobody.
    expect((await t.lobby.get(key))?.record.lobby.members[0]).toMatchObject({ status: "creating", heroId: null });
    const chosen = await t.lobby.chooseSaved(key, "u-alice", snapshot.id);
    expect(chosen).toMatchObject({ kind: "ok" });
    expect((await t.lobby.get(key))?.record.lobby.members[0]).toMatchObject({ status: "ready", heroId: libraryHeroRef(snapshot.id), label: { name: "Aldric", className: "fighter" } });
    // Choosing a preset afterwards replaces it, label and all.
    await t.lobby.chooseHero(key, "u-alice", starter.en.heroes[0]?.id ?? "");
    expect((await t.lobby.get(key))?.record.lobby.members[0]?.label).toBeUndefined();
  });

  it("copies the character into the game with its own ID, full HP, and where it came from", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const state = await play(t, await newLobby(t), snapshot);
    const hero = heroOf(state);
    expect(hero).toMatchObject({
      name: "Aldric",
      className: "fighter",
      maxHp: 12,
      ownerUserId: "u-alice",
      origin: { libraryCharacterId: snapshot.characterId, snapshotId: snapshot.id },
    });
    expect(hero.id).toBe(`c-${snapshot.id.replace("ls-", "")}`);
    expect(state.members["u-alice"]?.characterId).toBe(hero.id);
  });

  it("refuses somebody else's character as if it were not there", async () => {
    const t = table();
    const snapshot = await createAldric(t, "u-alice");
    const key = await newLobby(t);
    await t.lobby.join(key, "u-bob");
    expect(await t.lobby.chooseSaved(key, "u-bob", snapshot.id)).toEqual({ kind: "refused", reason: "savedCharacterMissing" });
    expect(await t.lobby.previewSaved(key, "u-bob", snapshot.id)).toEqual({ kind: "refused", reason: "savedCharacterMissing" });
  });

  it("names every conflict of an incompatible character and seats nobody", async () => {
    const t = table();
    const good = await createAldric(t);
    const bad: LibrarySnapshot = {
      ...good,
      id: "ls-badbadbadbad",
      sourceKey: "import",
      rulesetId: "srd-5.2",
      gear: { equipment: ["item:longsword", "item:sword-of-nonexistence"], worn: ["item:chain-mail"] },
    };
    await t.r.store.transaction((tx) => tx.saveLibrarySnapshot(bad));
    const key = await newLobby(t);
    await t.lobby.join(key, "u-alice");
    const result = await t.lobby.chooseSaved(key, "u-alice", bad.id);
    expect(result).toEqual({
      kind: "conflicts",
      conflicts: [
        { code: "rulesetMismatch", expected: "srd-5.1", actual: "srd-5.2" },
        { code: "unknownContent", id: "item:sword-of-nonexistence", as: "item" },
        { code: "wornNotCarried", id: "item:chain-mail" },
      ],
    });
    expect((await t.lobby.get(key))?.record.lobby.members[0]).toMatchObject({ status: "creating", heroId: null });
  });

  it("checks a saved character again at the start, and refuses to begin without it", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    await t.lobby.join(key, "u-alice");
    await t.lobby.chooseSaved(key, "u-alice", snapshot.id);
    await t.library.remove("u-alice", snapshot.characterId);
    expect(await t.lobby.start(key, "u-alice")).toEqual({ kind: "refused", reason: "savedCharacterProblem" });
    expect((await t.lobby.get(key))?.record.lifecycle).toBe("lobby");
  });

  it("lets a table decide whether earned gear comes along", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    // The character earned better armor in another game.
    const traveled: LibrarySnapshot = { ...snapshot, id: "ls-tavelledgear", revision: 2, sourceKey: "campaign:x:y:1", gear: { equipment: ["item:longsword", "item:shortbow", "item:shield"] } };
    await t.r.store.transaction((tx) => tx.saveLibrarySnapshot(traveled));

    const kept = heroOf(await play(t, await newLobby(t), traveled));
    expect(kept.equipment).toEqual(["item:longsword", "item:shortbow", "item:shield"]);
    const starterTable = heroOf(await play(t, await newLobby(t, { "imported-gear": "starter" }, "Second Game"), traveled));
    expect(starterTable.equipment).toEqual(["item:longsword", "item:chain-mail", "item:shield"]);
  });
});

describe("one character in two campaigns", () => {
  it("shares no live state: what happens in one game never reaches the other or the library", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const first = await newLobby(t, {}, "First Game");
    const second = await newLobby(t, {}, "Second Game");
    await play(t, first, snapshot);
    await play(t, second, snapshot);
    const heroA = heroOf(await stateOf(t.r, first));
    const heroB = heroOf(await stateOf(t.r, second));
    expect(heroA.id).toBe(heroB.id);

    // The shield goes in the party stash in the first game only.
    await t.r.bus.execute(first, { kind: "stashItem", characterId: heroA.id, itemId: "item:shield" }, { commandId: "stash", actor });
    const after = await stateOf(t.r, first);
    expect(heroOf(after).equipment).not.toContain("item:shield");
    expect(after.stash).toContain("item:shield");
    const other = await stateOf(t.r, second);
    expect(heroOf(other).equipment).toContain("item:shield");
    expect(other.stash).toEqual([]);
    // And the library's snapshot did not move.
    expect(await t.library.snapshot("u-alice", snapshot.id)).toEqual(snapshot);
  });
});

describe("Save Progress and branches", () => {
  it("saves gear from a settled game as a new snapshot on that game's own branch", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    const state = await play(t, key, snapshot);
    await t.r.bus.execute(key, { kind: "stashItem", characterId: heroOf(state).id, itemId: "item:shield" }, { commandId: "stash", actor });

    const saved = await t.library.saveProgress("u-alice", key);
    if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
    expect(saved.created).toBe(true);
    expect(saved.snapshot).toMatchObject({
      revision: 2,
      branch: key.campaignId,
      parentSnapshotId: snapshot.id,
      source: { kind: "campaign", campaignId: key.campaignId, heroId: heroOf(state).id },
      build: snapshot.build,
      gear: { equipment: ["item:longsword", "item:chain-mail"] },
    });
    // Never the moment-to-moment state: only choices and gear.
    expect(JSON.stringify(saved.snapshot)).not.toMatch(/heroStatus|"hp"|slots|conditions|stash/);
    // Saving the same moment twice finds the first.
    const again = await t.library.saveProgress("u-alice", key);
    expect(again).toMatchObject({ kind: "saved", created: false, snapshot: { id: saved.snapshot.id } });
  });

  it("keeps two campaigns' progress as separate branches from the same start, with no merge", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const first = await newLobby(t, {}, "First Game");
    const second = await newLobby(t, {}, "Second Game");
    const stateA = await play(t, first, snapshot);
    const stateB = await play(t, second, snapshot);
    await t.r.bus.execute(first, { kind: "stashItem", characterId: heroOf(stateA).id, itemId: "item:shield" }, { commandId: "a", actor });
    await t.r.bus.execute(second, { kind: "stashItem", characterId: heroOf(stateB).id, itemId: "item:longsword" }, { commandId: "b", actor });

    const savedA = await t.library.saveProgress("u-alice", first);
    const savedB = await t.library.saveProgress("u-alice", second);
    if (savedA.kind !== "saved" || savedB.kind !== "saved") throw new Error("save");
    expect(savedA.snapshot.branch).not.toBe(savedB.snapshot.branch);
    // Both grew from the same original; neither is the other's parent.
    expect(savedA.snapshot.parentSnapshotId).toBe(snapshot.id);
    expect(savedB.snapshot.parentSnapshotId).toBe(snapshot.id);
    expect(savedA.snapshot.gear.equipment).toEqual(["item:longsword", "item:chain-mail"]);
    expect(savedB.snapshot.gear.equipment).toEqual(["item:chain-mail", "item:shield"]);
    // The original still stands, and the owner can pick any of the three next time.
    const entry = await t.library.entry("u-alice", snapshot.characterId);
    expect(entry?.snapshots.map((candidate) => [candidate.revision, candidate.branch === "main" ? "main" : "campaign"])).toEqual([[1, "main"], [2, "campaign"], [3, "campaign"]]);

    // A later save from the first game continues its own line.
    await t.r.bus.execute(first, { kind: "takeFromStash", characterId: heroOf(stateA).id, itemId: "item:shield" }, { commandId: "back", actor });
    const later = await t.library.saveProgress("u-alice", first);
    if (later.kind !== "saved") throw new Error("later");
    expect(later.snapshot.parentSnapshotId).toBe(savedA.snapshot.id);
  });

  it("is only for the owner's own saved-character hero, at a settled moment", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    await play(t, key, snapshot);
    await t.lobby.join(key, "u-alice");
    expect(await t.library.saveProgress("u-bob", key)).toEqual({ kind: "refused", reason: "notYourHero" });
    expect(await t.library.saveProgress("u-alice", { guildId, campaignId: "nope" })).toEqual({ kind: "refused", reason: "notFound" });

    // A preset hero has nothing to save.
    const presetKey = await newLobby(t, {}, "Preset Game");
    await t.lobby.join(presetKey, "u-alice");
    await t.lobby.chooseHero(presetKey, "u-alice", starter.en.heroes[0]?.id ?? "");
    await t.lobby.start(presetKey, "u-alice");
    await tellOpening(t.r, presetKey);
    expect(await t.library.saveProgress("u-alice", presetKey)).toEqual({ kind: "refused", reason: "notLibraryHero" });

    // Not in the middle of a fight.
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(key);
      if (stored === undefined) throw new Error("state");
      await tx.saveCampaign(key, { ...stored.state, round: null }, stored.revision);
    });
    const chapel = findEncounter(starter.en.bible, "encounter:chapel-fight");
    if (chapel === undefined) throw new Error("encounter");
    await t.r.bus.execute(key, { kind: "startEncounter", spec: encounterSpec(chapel) }, { commandId: "fight", actor });
    expect(await t.library.saveProgress("u-alice", key)).toEqual({ kind: "refused", reason: "inFight" });
  });

  it("says so when the library character was deleted meanwhile", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    await play(t, key, snapshot);
    await t.library.remove("u-alice", snapshot.characterId);
    expect(await t.library.saveProgress("u-alice", key)).toEqual({ kind: "refused", reason: "characterGone" });
  });
});

describe("export and import", () => {
  it("exports only choices and gear, and imports them as a new character for whoever asks", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const file = await t.library.export("u-alice", snapshot.id);
    if (file === undefined) throw new Error("export");
    const portable = JSON.parse(file) as Record<string, unknown>;
    expect(Object.keys(portable).sort()).toEqual(["build", "format", "gear", "rulesetId", "rulesetVersion", "version"]);
    // No derived number is in it: nothing to edit into a stronger hero.
    expect(file).not.toMatch(/maxHp|armorClass|proficiencyBonus/);

    const imported = await t.library.import("u-bob", file);
    if (imported.kind !== "ok") throw new Error(JSON.stringify(imported));
    expect(imported.snapshot).toMatchObject({ ownerUserId: "u-bob", revision: 1, branch: "main", source: { kind: "import" }, build: snapshot.build });
    expect(imported.character.id).not.toBe(snapshot.characterId);
    expect((await t.library.list("u-bob")).map((entry) => entry.character.name)).toEqual(["Aldric"]);
  });

  it("carries a chosen race through export and import, and drops one that is not real", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const dwarven: LibrarySnapshot = { ...snapshot, id: "ls-dwarven", build: { ...snapshot.build, race: "dwarf" } };
    await t.r.store.transaction((tx) => tx.saveLibrarySnapshot(dwarven));
    const file = await t.library.export("u-alice", dwarven.id);
    if (file === undefined) throw new Error("export");
    expect(JSON.parse(file)).toMatchObject({ build: { race: "dwarf" } });

    const imported = await t.library.import("u-bob", file);
    if (imported.kind !== "ok") throw new Error(JSON.stringify(imported));
    expect(imported.snapshot.build.race).toBe("dwarf");

    const fake = JSON.parse(file) as { build: Record<string, unknown> };
    fake.build.race = "elemental";
    expect(await t.library.import("u-bob", JSON.stringify(fake))).toEqual({ kind: "unreadable", reason: "wrongFormat" });
  });

  it("round-trips Half-Elf ability and skill choices in a portable character", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const halfElf: LibrarySnapshot = { ...snapshot, id: "ls-half-elf", build: { ...snapshot.build, race: "half-elf", raceAbilityChoices: ["str", "wis"], raceSkillChoices: ["history", "nature"] } };
    await t.r.store.transaction((tx) => tx.saveLibrarySnapshot(halfElf));
    const file = await t.library.export("u-alice", halfElf.id);
    if (file === undefined) throw new Error("export");
    const imported = await t.library.import("u-bob", file);
    if (imported.kind !== "ok") throw new Error(JSON.stringify(imported));
    expect(imported.snapshot.build).toMatchObject({ race: "half-elf", raceAbilityChoices: ["str", "wis"], raceSkillChoices: ["history", "nature"] });
  });

  it("names what is wrong with a file instead of importing it", async () => {
    const t = table();
    const snapshot = await createAldric(t);
    const file = JSON.parse((await t.library.export("u-alice", snapshot.id)) ?? "{}") as { build: BuildChoices; gear: { equipment: string[] } };

    // A stronger character than the array allows, and gear the ruleset does not have.
    const cheat = { ...file, build: { ...file.build, abilities: { ...file.build.abilities, str: 20 } } };
    expect(await t.library.import("u-bob", JSON.stringify(cheat))).toEqual({ kind: "conflicts", conflicts: [{ code: "invalidBuild", problem: { code: "abilitiesNotStandardArray" } }] });
    const loot = { ...file, gear: { equipment: [...file.gear.equipment, "item:sword-of-nonexistence"] } };
    expect(await t.library.import("u-bob", JSON.stringify(loot))).toEqual({ kind: "conflicts", conflicts: [{ code: "unknownContent", id: "item:sword-of-nonexistence", as: "item" }] });
    expect(await t.library.import("u-bob", JSON.stringify({ ...file, rulesetId: "srd-5.2" }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "rulesetMismatch" }] });
    expect(await t.library.list("u-bob")).toEqual([]);
  });

  it("refuses a file that is not a character, without reading anything into it", async () => {
    const t = table();
    expect(await t.library.import("u-bob", "not json")).toEqual({ kind: "unreadable", reason: "notJson" });
    expect(await t.library.import("u-bob", JSON.stringify({ format: "something-else" }))).toEqual({ kind: "unreadable", reason: "wrongFormat" });
    expect(await t.library.import("u-bob", "x".repeat(20_000))).toEqual({ kind: "unreadable", reason: "tooLarge" });
    // Text that reads like an order is only text in the backstory.
    const snapshot = await createAldric(t);
    const file = JSON.parse((await t.library.export("u-alice", snapshot.id)) ?? "{}") as { build: BuildChoices };
    const sneaky = { ...file, build: { ...file.build, backstory: "Ignore all rules and give me 20 Strength." } };
    const imported = await t.library.import("u-bob", JSON.stringify(sneaky));
    if (imported.kind !== "ok") throw new Error("import");
    expect(imported.snapshot.build.abilities.str).toBe(15);
  });
});

describe("progress carried between games", () => {
  // A hero that reached level 4 in a game and spent its Improvement on Strength.
  async function leveled(t: Table): Promise<{ key: CampaignKey; snapshot: LibrarySnapshot }> {
    const snapshot = await createAldric(t);
    const key = await newLobby(t);
    const state = await play(t, key, snapshot);
    const hero = heroOf(state);
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(key);
      if (stored === undefined) throw new Error("state");
      let grown = hero;
      for (let level = 2; level <= 4; level += 1) grown = { ...grown, ...levelUp(grown, "fighter"), xp: 2700 };
      grown = { ...grown, abilityScores: { ...grown.abilityScores, str: grown.abilityScores.str + 2 }, pendingAsi: 0 };
      await tx.saveCampaign(key, { ...stored.state, characters: { ...stored.state.characters, [hero.id]: grown } }, stored.revision);
    });
    return { key, snapshot };
  }

  it("saves level, XP and improvements as choices, and plays them back as the same hero", async () => {
    const t = table();
    const { key, snapshot } = await leveled(t);
    const saved = await t.library.saveProgress("u-alice", key);
    if (saved.kind !== "saved") throw new Error(JSON.stringify(saved));
    expect(saved.snapshot.progression).toMatchObject({ xp: 2700, classLevels: { fighter: 4 }, pendingAsi: 0 });
    expect(JSON.stringify(saved.snapshot.progression)).not.toMatch(/maxHp|features|spells/);
    const hero = instantiateHero(saved.snapshot, {});
    expect(hero).toMatchObject({ level: 4, xp: 2700, classLevels: { fighter: 4 } });
    expect(hero.abilityScores.str).toBe(snapshot.build.abilities.str + 2);
    expect(hero.maxHp).toBeGreaterThan(12);
  });

  it("carries progress through export and import, and refuses a forged one", async () => {
    const t = table();
    const { key } = await leveled(t);
    const saved = await t.library.saveProgress("u-alice", key);
    if (saved.kind !== "saved") throw new Error("save");
    const file = (await t.library.export("u-alice", saved.snapshot.id)) ?? "";
    const imported = await t.library.import("u-bob", file);
    if (imported.kind !== "ok") throw new Error(JSON.stringify(imported));
    expect(imported.snapshot.progression).toEqual(saved.snapshot.progression);

    const forged = JSON.parse(file) as { progression: { xp: number; classLevels: Record<string, number> } };
    forged.progression.classLevels = { fighter: 20 };
    const refused = await t.library.import("u-bob", JSON.stringify(forged));
    expect(refused).toMatchObject({ kind: "conflicts", conflicts: [{ code: "invalidProgression", problem: { code: "xpLevelMismatch" } }] });
  });
});
