import { describe, expect, it } from "vitest";

import type { LibrarySnapshot } from "../../../../src/application/campaign/library/library-types.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { BuildChoices } from "../../../../src/domain/campaign/character/character-build.js";
import { CharacterLibraryComponentHandler } from "../../../../src/infrastructure/discord/components/character-library-component-handler.js";
import { libraryCustomId } from "../../../../src/infrastructure/discord/campaign/library-ids.js";
import { quiet, rig, tellOpening, type Rig } from "../../../application/campaign/campaign-rig.js";
import { ruleset } from "../../../domain/campaign/campaign-fixtures.js";
import { contentOf, fakeInteraction, harness, heroes, type Harness, type Sent } from "./handler-harness.js";

interface Menu {
  readonly id: string;
  readonly options: readonly { value: string; label: string }[];
  readonly min?: number;
  readonly max?: number;
}
interface Screen {
  readonly content: string;
  readonly menus: Menu[];
  readonly buttons: { id: string; label: string; disabled?: boolean }[];
  readonly files: { name: string; text: string }[];
}

function screenOf(sent: readonly Sent[]): Screen {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const payload = last?.payload as { content?: string; components?: { toJSON(): { components: Record<string, unknown>[] } }[]; files?: { attachment: Buffer; name: string }[] } | undefined;
  const menus: Menu[] = [];
  const buttons: Screen["buttons"] = [];
  for (const row of payload?.components ?? []) {
    for (const component of row.toJSON().components) {
      if (Array.isArray(component.options)) {
        menus.push({ id: String(component.custom_id), options: component.options as Menu["options"], min: component.min_values as number, max: component.max_values as number });
      } else buttons.push({ id: String(component.custom_id), label: String(component.label), disabled: component.disabled === true });
    }
  }
  return { content: payload?.content ?? "", menus, buttons, files: (payload?.files ?? []).map((file) => ({ name: file.name, text: file.attachment.toString("utf8") })) };
}

const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };

function libraryHandler(r: Rig): CharacterLibraryComponentHandler {
  return new CharacterLibraryComponentHandler({ library: r.library, content: ruleset().content, glossaries });
}

async function click(handler: CharacterLibraryComponentHandler, customId: string, userId = "u-alice", options: { values?: string[]; locale?: string } = {}): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId, userId, values: options.values ?? [], kind: options.values === undefined ? "button" : "select", ...(options.locale === undefined ? {} : { locale: options.locale }) });
  await handler.execute({ interaction, logger: quiet as never });
  return sent;
}

async function submitName(handler: CharacterLibraryComponentHandler, customId: string, userId: string, fields: Record<string, string>, locale?: string): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId, userId, fields, kind: "modal", ...(locale === undefined ? {} : { locale }) });
  await handler.executeModal({ interaction, logger: quiet as never });
  return sent;
}

const fighterBuild: BuildChoices = {
  class: "fighter",
  kit: "knight",
  abilities: { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 },
  skills: ["athletics", "perception"],
  expertise: [],
  name: "Aldric",
  appearance: "",
  backstory: "",
};

describe("My Characters", () => {
  it("asks a Half-Elf to choose two distinct non-Charisma ability bonuses before the kit", async () => {
    const handler = libraryHandler(rig());
    let screen = screenOf(await click(handler, libraryCustomId("new")));
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["fighter"] }));
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["half-elf"] }));
    expect(screen.content).toContain("choose 2 more ability");
    expect(screen.menus[0]?.options.map((option) => option.value)).not.toContain("cha");
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["str"] }));
    expect(screen.content).toContain("choose 1 more ability");
    expect(screen.menus[0]?.options.map((option) => option.value)).not.toContain("str");
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["wis"] }));
    expect(screen.content).toContain("choose two extra skill proficiencies");
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["history", "nature"] }));
    expect(screen.content).toContain("Choose a starting kit");
  });

  it("starts empty with a way to build, and lists what the user has", async () => {
    const r = rig();
    const handler = libraryHandler(r);
    const empty = await handler.homeScreen("u-alice", "en");
    expect(empty.content).toContain("You have no saved characters yet");
    await r.library.create("u-alice", fighterBuild);
    const home = await handler.homeScreen("u-alice", "en");
    expect(home.content).toContain("**Aldric** — Fighter · 1 saved");
    // Someone else's list is theirs.
    expect((await handler.homeScreen("u-bob", "en")).content).toContain("You have no saved characters yet");
  });

  it("walks the guided builder from class to a saved rogue, keeping its choices in the controls", async () => {
    const r = rig();
    const handler = libraryHandler(r);
    let screen = screenOf(await click(handler, libraryCustomId("new")));
    expect(screen.menus[0]?.options.map((option) => option.value)).toEqual([
      "fighter",
      "rogue",
      "cleric",
      "barbarian",
      "bard",
      "druid",
      "monk",
      "paladin",
      "ranger",
      "sorcerer",
      "warlock",
      "wizard",
    ]);

    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["rogue"] }));
    expect(screen.content).toBe("Choose a race for your Rogue.");
    expect(screen.menus[0]?.options.map((option) => option.value)).toEqual(["human", "hill-dwarf", "mountain-dwarf", "high-elf", "wood-elf", "drow", "lightfoot-halfling", "stout-halfling", "black-dragonborn", "blue-dragonborn", "brass-dragonborn", "bronze-dragonborn", "copper-dragonborn", "gold-dragonborn", "green-dragonborn", "red-dragonborn", "silver-dragonborn", "white-dragonborn", "forest-gnome", "rock-gnome", "half-elf", "half-orc", "tiefling"]);

    // High Elf raises Dexterity by 2 and Intelligence by 1.
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["high-elf"] }));
    expect(screen.content).toBe("Choose a starting kit for your Rogue.");
    expect(screen.menus[0]?.options.map((option) => option.value)).toEqual(["shadow", "duelist"]);

    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["shadow"] }));
    // A rogue picks exactly four skills.
    expect(screen.content).toBe("Choose 4 skills you are good at.");
    expect(screen.menus[0]).toMatchObject({ min: 4, max: 4 });
    expect(screen.menus[0]?.options.map((option) => option.label)).toContain("Stealth (DEX)");

    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["stealth", "perception", "acrobatics", "deception"] }));
    expect(screen.content).toContain("Choose 2 of them to be expert in");
    expect(screen.menus[0]?.options.map((option) => option.value)).toEqual(["stealth", "perception", "acrobatics", "deception"]);

    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["stealth", "perception"] }));
    expect(screen.content).toContain("Give **15** to which ability?");
    // By hand: Dexterity 15, Charisma 14.
    screen = screenOf(await click(handler, screen.menus[0]?.id ?? "", "u-alice", { values: ["dex"] }));
    expect(screen.content).toContain("Give **14** to which ability? (Dexterity 15)");
    expect(screen.menus[0]?.options.map((option) => option.value)).not.toContain("dex");
    // Or take the suggestion for the rest.
    const suggested = screen.buttons.find((button) => button.label === "Use the suggested scores");
    screen = screenOf(await click(handler, suggested?.id ?? ""));
    expect(screen.content).toContain("Scores set:");
    const nameButton = screen.buttons.find((button) => button.label === "Name your character");
    expect(nameButton?.id.length).toBeLessThan(100);

    const named = screenOf(await submitName(handler, nameButton?.id ?? "", "u-alice", { name: "  Wren  ", appearance: "Quick and quiet.", backstory: "" }));
    expect(named.content).toBe("**Wren** is saved to your library (Rogue · 9 HP · AC 14). Pick it when you join a game.");
    const saved = (await r.library.list("u-alice"))[0]?.snapshots[0];
    expect(saved?.build).toMatchObject({ class: "rogue", race: "high-elf", kit: "shadow", name: "Wren", skills: ["stealth", "perception", "acrobatics", "deception"], expertise: ["stealth", "perception"], appearance: "Quick and quiet." });
    expect(saved?.build.abilities).toEqual({ dex: 15, cha: 14, int: 13, con: 12, wis: 10, str: 8 });
  });

  it("names the trouble when a tampered form or draft would make an illegal character", async () => {
    const r = rig();
    const handler = libraryHandler(r);
    // A name too long for the form's own limit still reaches the check.
    const sent = await submitName(handler, libraryCustomId("bName", "fh0.ab..dcsiwh"), "u-alice", { name: "x".repeat(41), appearance: "", backstory: "" });
    expect(contentOf(sent)).toContain("the name must be 1 to 40 characters");
    // An unfinished draft is not a character.
    expect(contentOf(await submitName(handler, libraryCustomId("bName", "f0.ab.."), "u-alice", { name: "Aldric", appearance: "", backstory: "" }))).toContain("standard array");
    expect(await r.library.list("u-alice")).toEqual([]);
  });

  it("shows a character with its saved versions, exports a file of choices and gear, and deletes on confirm", async () => {
    const r = rig();
    const handler = libraryHandler(r);
    const made = await r.library.create("u-alice", fighterBuild);
    if (made.kind !== "ok") throw new Error("create");
    const view = screenOf(await click(handler, "dndchar:view", "u-alice", { values: [made.character.id] }));
    expect(view.content).toContain("**Aldric** — Fighter");
    expect(view.content).toContain("Abilities: Strength 15");
    expect(view.content).toContain("v1 · the builder · Longsword, Chain Mail, Shield");

    const exportButton = view.buttons.find((button) => button.label === "Export");
    const exported = screenOf(await click(handler, exportButton?.id ?? ""));
    expect(exported.files).toHaveLength(1);
    expect(exported.files[0]?.name).toBe("Aldric.json");
    expect(JSON.parse(exported.files[0]?.text ?? "{}")).toMatchObject({ format: "dnd-character", build: { name: "Aldric" } });

    const ask = screenOf(await click(handler, view.buttons.find((button) => button.label === "Delete")?.id ?? ""));
    expect(ask.content).toContain("Delete **Aldric** and every saved version of it?");
    expect((await r.library.list("u-alice")).length).toBe(1);
    const done = screenOf(await click(handler, ask.buttons.find((button) => button.label === "Delete it")?.id ?? ""));
    expect(done.content).toContain("**Aldric** was deleted.");
    expect(await r.library.list("u-alice")).toEqual([]);
  });

  it("gives another user nothing of someone else's character, however they got the ID", async () => {
    const r = rig();
    const handler = libraryHandler(r);
    const made = await r.library.create("u-alice", fighterBuild);
    if (made.kind !== "ok") throw new Error("create");
    expect(screenOf(await click(handler, "dndchar:view", "u-bob", { values: [made.character.id] })).content).toBe("That character is not in your library.");
    expect(screenOf(await click(handler, libraryCustomId("export", made.snapshot.id), "u-bob")).content).toBe("That character is not in your library.");
    expect(screenOf(await click(handler, libraryCustomId("deleteAsk", made.character.id), "u-bob")).content).toBe("That character is not in your library.");
    const stolen = screenOf(await click(handler, libraryCustomId("deleteYes", made.character.id), "u-bob"));
    expect(stolen.content).toContain("That character is not in your library.");
    expect((await r.library.list("u-alice")).length).toBe(1);
  });

  it("speaks Traditional Chinese to a person whose Discord is in Chinese", async () => {
    const r = rig();
    const handler = libraryHandler(r);
    await r.library.create("u-alice", fighterBuild);
    const sent = await click(handler, libraryCustomId("home"), "u-alice", { locale: "zh-TW" });
    expect(screenOf(sent).content).toContain("我的角色");
    expect(screenOf(sent).content).toContain("**Aldric** — 戰士 · 已存 1 個版本");
    const builder = screenOf(await click(handler, libraryCustomId("new"), "u-alice", { locale: "zh-TW" }));
    expect(builder.content).toBe("請選擇職業");
    const races = screenOf(await click(handler, builder.menus[0]?.id ?? "", "u-alice", { values: ["fighter"], locale: "zh-TW" }));
    expect(races.menus[0]?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "mountain-dwarf", label: "高山矮人" }),
      expect.objectContaining({ value: "stout-halfling", label: "強魄半身人" }),
      expect.objectContaining({ value: "forest-gnome", label: "林地侏" }),
      expect.objectContaining({ value: "rock-gnome", label: "岩地侏" }),
    ]));
  });
});

// ---- a saved character in a game's lobby -------------------------------------

async function savedInLobby(t: Harness, owner = "u-org"): Promise<LibrarySnapshot> {
  const made = await t.r.library.create(owner, fighterBuild);
  if (made.kind !== "ok") throw new Error("create");
  return made.snapshot;
}

async function heroPicker(t: Harness, userId = "u-org"): Promise<Screen> {
  await t.press("join", userId);
  return screenOf(await t.press("pickHero", userId));
}

describe("choosing a saved character when joining a game", () => {
  it("offers saved characters after the adventure's own heroes, and previews before seating", async () => {
    const t = await harness();
    const snapshot = await savedInLobby(t);
    const picker = await heroPicker(t);
    const values = picker.menus[0]?.options.map((option) => option.value) ?? [];
    expect(values.slice(0, heroes.length)).toEqual(heroes.map((hero) => hero.id));
    expect(values.at(-1)).toBe(`lib:${snapshot.id}`);
    expect(picker.menus[0]?.options.at(-1)?.label).toBe("★ Aldric — Fighter, v1");

    const chosen = fakeInteraction({ customId: `dnd:heroChoice:${t.key.campaignId}`, userId: "u-org", values: [`lib:${snapshot.id}`], kind: "select" });
    await t.handler.execute({ interaction: chosen.interaction, logger: quiet as never });
    const preview = screenOf(chosen.sent);
    expect(preview.content).toContain("**Aldric** — Fighter, level 1");
    expect(preview.content).toContain("HP 12 · Gear: Longsword, Chain Mail, Shield");
    expect(preview.content).toContain("nothing that happens in it changes your saved character");
    // Looking seats nobody.
    expect((await t.r.service.get(t.key))?.record.lobby.members[0]).toMatchObject({ heroId: null });

    const confirm = preview.buttons.find((button) => button.label === "Play this character");
    const done = fakeInteraction({ customId: confirm?.id ?? "", userId: "u-org", kind: "button" });
    await t.handler.execute({ interaction: done.interaction, logger: quiet as never });
    expect(contentOf(done.sent)).toBe("You will play **Aldric**, from your library.");
    expect((await t.r.service.get(t.key))?.record.lobby.members[0]).toMatchObject({ status: "ready", heroId: `lib:${snapshot.id}` });
  });

  it("names every conflict of an incompatible character and offers no way to play it", async () => {
    const t = await harness();
    const good = await savedInLobby(t);
    const bad: LibrarySnapshot = { ...good, id: "ls-badbadbadbad", sourceKey: "import", gear: { equipment: ["item:longsword", "item:sword-of-nonexistence"] } };
    await t.r.store.transaction((tx) => tx.saveLibrarySnapshot(bad));
    await t.press("join", "u-org");
    const chosen = fakeInteraction({ customId: `dnd:heroChoice:${t.key.campaignId}`, userId: "u-org", values: [`lib:${bad.id}`], kind: "select" });
    await t.handler.execute({ interaction: chosen.interaction, logger: quiet as never });
    const preview = screenOf(chosen.sent);
    expect(preview.content).toContain("This character cannot join this game:");
    expect(preview.content).toContain("• item:sword-of-nonexistence is not in this game's rules.");
    expect(preview.buttons).toEqual([]);
  });

  it("shows someone else's saved character to nobody, and refuses it if the ID is guessed", async () => {
    const t = await harness();
    const snapshot = await savedInLobby(t, "u-alice");
    const picker = await heroPicker(t, "u-org");
    expect((picker.menus[0]?.options ?? []).some((option) => option.value.startsWith("lib:"))).toBe(false);
    const guessed = fakeInteraction({ customId: `dnd:heroChoice:${t.key.campaignId}`, userId: "u-org", values: [`lib:${snapshot.id}`], kind: "select" });
    await t.handler.execute({ interaction: guessed.interaction, logger: quiet as never });
    expect(contentOf(guessed.sent)).toBe("That saved character is not in your library.");
    const confirm = fakeInteraction({ customId: `dnd:useSaved:${t.key.campaignId}:${snapshot.id}`, userId: "u-org", kind: "button" });
    await t.handler.execute({ interaction: confirm.interaction, logger: quiet as never });
    expect(contentOf(confirm.sent)).toBe("That saved character is not in your library.");
  });
});

describe("Save progress from a game", () => {
  async function playing(): Promise<{ t: Harness; snapshot: LibrarySnapshot }> {
    const t = await harness();
    const snapshot = await savedInLobby(t);
    await t.press("join", "u-org");
    const chosen = fakeInteraction({ customId: `dnd:useSaved:${t.key.campaignId}:${snapshot.id}`, userId: "u-org", kind: "button" });
    await t.handler.execute({ interaction: chosen.interaction, logger: quiet as never });
    await t.press("start", "u-org");
    await tellOpening(t.r, t.key);
    await t.cards.sync(t.key);
    return { t, snapshot };
  }
  const saveButton = (sent: readonly Sent[]): boolean => screenOf(sent).buttons.some((button) => button.label === "Save progress");

  it("puts Save progress on My Hero for a hero from the library, and saves a new version", async () => {
    const { t, snapshot } = await playing();
    const sheet = await t.press("myHero", "u-org");
    expect(saveButton(sheet)).toBe(true);
    const saved = await t.press("saveProgress", "u-org", { onCard: "adventure" });
    expect(contentOf(saved)).toBe("Progress saved: **Aldric**, version 2. Pick it when you join another game.");
    expect(contentOf(await t.press("saveProgress", "u-org", { onCard: "adventure" }))).toBe("That moment is already saved.");
    expect((await t.r.library.entry("u-org", snapshot.characterId))?.snapshots).toHaveLength(2);
  });

  it("is not on a preset hero's sheet", async () => {
    const t = await harness();
    await t.press("join", "u-org");
    await t.select("u-org", heroes[0]?.id ?? "");
    await t.press("start", "u-org");
    await tellOpening(t.r, t.key);
    await t.cards.sync(t.key);
    expect(saveButton(await t.press("myHero", "u-org"))).toBe(false);
    expect(contentOf(await t.press("saveProgress", "u-org", { onCard: "adventure" }))).toContain("Only a character from your library can save progress");
  });
});
