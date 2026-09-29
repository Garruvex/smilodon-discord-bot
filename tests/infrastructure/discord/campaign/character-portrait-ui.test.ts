import { describe, expect, it } from "vitest";

import { CharacterPortraits } from "../../../../src/application/campaign/library/character-portraits.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { BuildChoices } from "../../../../src/domain/campaign/character/character-build.js";
import { libraryCustomId } from "../../../../src/infrastructure/discord/campaign/library-ids.js";
import { CharacterLibraryComponentHandler } from "../../../../src/infrastructure/discord/components/character-library-component-handler.js";
import { MemoryPortraitStore, Painter, pngBytes, Stylizer } from "../../../application/campaign/portrait-fakes.js";
import { quiet, rig, type Rig } from "../../../application/campaign/campaign-rig.js";
import { ruleset } from "../../../domain/campaign/campaign-fixtures.js";
import { fakeInteraction, type Sent } from "./handler-harness.js";

interface Screen {
  readonly content: string;
  readonly menus: { id: string; options: { value: string; label: string }[] }[];
  readonly buttons: { id: string; label: string }[];
  readonly files: number;
}

function screenOf(sent: readonly Sent[]): Screen {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const payload = last?.payload as { content?: string; components?: { toJSON(): { components: Record<string, unknown>[] } }[]; files?: unknown[] } | undefined;
  const menus: Screen["menus"] = [];
  const buttons: Screen["buttons"] = [];
  for (const row of payload?.components ?? []) {
    for (const component of row.toJSON().components) {
      if (Array.isArray(component.options)) menus.push({ id: String(component.custom_id), options: component.options as Screen["menus"][number]["options"] });
      else buttons.push({ id: String(component.custom_id), label: String(component.label) });
    }
  }
  return { content: payload?.content ?? "", menus, buttons, files: payload?.files?.length ?? 0 };
}

const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };

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

const upload = { url: "https://cdn.discordapp.com/attachments/1/2/me.png", size: 1_000 };

interface Table {
  readonly handler: CharacterLibraryComponentHandler;
  readonly portraits: CharacterPortraits;
  readonly stylizer: Stylizer;
  readonly painter: Painter;
  readonly store: MemoryPortraitStore;
  readonly characterId: string;
}

async function table(r: Rig, options: { stylizer?: boolean; downloaded?: Buffer | "fail" } = {}): Promise<Table> {
  const store = new MemoryPortraitStore();
  const stylizer = new Stylizer();
  const painter = new Painter();
  const portraits = new CharacterPortraits({ library: r.library, store, clock: r.clock, generator: painter, ...(options.stylizer === false ? {} : { stylizer }) });
  const downloaded = options.downloaded ?? pngBytes;
  const handler = new CharacterLibraryComponentHandler({
    library: r.library,
    content: ruleset().content,
    glossaries,
    portraits,
    downloadImage: (): ReturnType<NonNullable<ConstructorParameters<typeof CharacterLibraryComponentHandler>[0]["downloadImage"]>> => Promise.resolve(downloaded === "fail" ? ({ ok: false, reason: "failed" } as const) : ({ ok: true, bytes: downloaded } as const)),
  });
  const made = await r.library.create("u-alice", fighterBuild);
  if (made.kind !== "ok") throw new Error("create");
  return { handler, portraits, stylizer, painter, store, characterId: made.character.id };
}

async function click(handler: CharacterLibraryComponentHandler, customId: string, userId = "u-alice", options: { values?: string[]; locale?: string } = {}): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId, userId, values: options.values ?? [], kind: options.values === undefined ? "button" : "select", ...(options.locale === undefined ? {} : { locale: options.locale }) });
  await handler.execute({ interaction, logger: quiet as never });
  return sent;
}

async function submitUpload(
  handler: CharacterLibraryComponentHandler,
  characterId: string,
  extra: { style?: string; note?: string; uploads?: Record<string, { url: string; size: number }[]>; userId?: string } = {},
): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({
    customId: libraryCustomId("pSubmit", characterId),
    userId: extra.userId ?? "u-alice",
    kind: "modal",
    fields: { note: extra.note ?? "" },
    selects: { style: [extra.style ?? "painterly"] },
    uploads: extra.uploads ?? { file: [upload] },
  });
  await handler.executeModal({ interaction, logger: quiet as never });
  return sent;
}

async function submitName(handler: CharacterLibraryComponentHandler, draft: string): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId: libraryCustomId("bName", draft), userId: "u-alice", kind: "modal", fields: { name: "Aldric", appearance: "", backstory: "" } });
  await handler.executeModal({ interaction, logger: quiet as never });
  return sent;
}

describe("portraits on My Characters", () => {
  it("offers a portrait right after a character is made, and only when portraits are set up", async () => {
    const r = rig();
    const { handler } = await table(r);
    const draft = "fh0.ab..dcsiwh";
    const named = screenOf(await submitName(handler, draft));
    expect(named.content).toContain("Want it to look like you?");
    expect(named.buttons.map((button) => button.label)).toEqual(["Portrait", "View character"]);
    expect(named.buttons[0]?.id).toMatch(/^dndchar:pHome:lc-/);

    // A bot with no image model offers nothing.
    const plain = new CharacterLibraryComponentHandler({ library: rig().library, content: ruleset().content, glossaries });
    const bare = screenOf(await submitName(plain, draft));
    expect(bare.buttons).toEqual([]);
    expect(bare.content).not.toContain("portrait");
  });

  it("puts a Portrait button on the character and opens the portrait screen with the ways to make one", async () => {
    const r = rig();
    const { handler, characterId } = await table(r);
    const view = screenOf(await click(handler, "dndchar:view", "u-alice", { values: [characterId] }));
    expect(view.buttons.map((button) => button.label)).toEqual(["Portrait", "Export", "Delete", "Back"]);
    const home = screenOf(await click(handler, libraryCustomId("pHome", characterId)));
    expect(home.content).toContain("**Portrait for Aldric**");
    expect(home.content).toContain("not kept");
    expect(home.content).toContain("No portrait yet");
    expect(home.buttons.map((button) => button.label)).toEqual(["Upload a picture", "Paint from description", "Back"]);
  });

  it("opens one form for the picture, the look and any extra words", async () => {
    const r = rig();
    const { handler, characterId } = await table(r);
    const sent = await click(handler, libraryCustomId("pUpload", characterId));
    const modal = sent.find((entry) => entry.kind === "modal")?.payload as { toJSON(): { custom_id: string; components: { label: string; component: { custom_id: string } }[] } };
    const json = modal.toJSON();
    expect(json.custom_id).toBe(libraryCustomId("pSubmit", characterId));
    expect(json.components.map((row) => row.label)).toEqual(["Your picture", "Style", "Anything to add? (optional)"]);
    expect(json.components.map((row) => row.component.custom_id)).toEqual(["file", "style", "note"]);
  });

  it("turns an upload into a preview, then keeps it on a yes and shows it on the character", async () => {
    const r = rig();
    const { handler, portraits, stylizer, store, characterId } = await table(r);
    const preview = screenOf(await submitUpload(handler, characterId, { style: "ink", note: "a red cloak" }));
    expect(preview.content).toContain("**Aldric** in *Comic-book ink*");
    expect(preview.files).toBe(1);
    expect(preview.menus[0]?.id).toBe(libraryCustomId("pStyle", characterId));
    expect(preview.menus[0]?.options.map((option) => option.label)).toContain("Comic-book ink");
    expect(preview.buttons.map((button) => button.label)).toEqual(["Use this portrait", "Try again", "Discard"]);
    expect(stylizer.requests[0]?.prompt).toContain("a red cloak");
    // Nothing is kept until the yes.
    expect(await portraits.current("u-alice", characterId)).toBeUndefined();

    const used = screenOf(await click(handler, libraryCustomId("pUse", characterId)));
    expect(used.content).toContain("Portrait saved for **Aldric**");
    expect(used.files).toBe(1);
    expect((await portraits.current("u-alice", characterId))?.bytes.toString()).toBe("styled");
    // The upload it came from is let go.
    expect(store.images.has(`${characterId}:source`)).toBe(false);
  });

  it("tries again, or another style, from the same upload without asking for it again", async () => {
    const r = rig();
    const { handler, stylizer, characterId } = await table(r);
    await submitUpload(handler, characterId, { style: "painterly" });
    const again = screenOf(await click(handler, libraryCustomId("pRetry", characterId)));
    expect(again.buttons.map((button) => button.label)).toContain("Use this portrait");
    const restyled = screenOf(await click(handler, libraryCustomId("pStyle", characterId), "u-alice", { values: ["watercolor"] }));
    expect(restyled.content).toContain("*Storybook watercolor*");
    expect(stylizer.requests).toHaveLength(3);
    expect(stylizer.requests[2]?.prompt).toContain("watercolour");
  });

  it("discards a candidate and returns to the portrait screen", async () => {
    const r = rig();
    const { handler, portraits, characterId } = await table(r);
    await submitUpload(handler, characterId);
    const home = screenOf(await click(handler, libraryCustomId("pDrop", characterId)));
    expect(home.content).toContain("**Portrait for Aldric**");
    expect(await portraits.candidate("u-alice", characterId)).toBeUndefined();
  });

  it("paints from the description when there is no picture, and offers the same three answers", async () => {
    const r = rig();
    const { handler, painter, characterId } = await table(r);
    const preview = screenOf(await click(handler, libraryCustomId("pPaint", characterId)));
    expect(preview.buttons.map((button) => button.label)).toEqual(["Use this portrait", "Try again", "Discard"]);
    expect(painter.prompts[0]).toContain("Aldric");
    expect(painter.prompts[0]).not.toContain("reference picture");
  });

  it("removes the portrait in use", async () => {
    const r = rig();
    const { handler, portraits, characterId } = await table(r);
    await click(handler, libraryCustomId("pPaint", characterId));
    await click(handler, libraryCustomId("pUse", characterId));
    const home = screenOf(await click(handler, libraryCustomId("pHome", characterId)));
    expect(home.files).toBe(1);
    expect(home.buttons.map((button) => button.label)).toContain("Remove portrait");
    const removed = screenOf(await click(handler, libraryCustomId("pRemove", characterId)));
    expect(removed.content).toContain("Portrait removed.");
    expect(removed.files).toBe(0);
    expect(await portraits.current("u-alice", characterId)).toBeUndefined();
  });

  it("explains why, and goes back, when the picture cannot be used", async () => {
    const r = rig();
    const html = await table(r, { downloaded: Buffer.from("<html>not a picture</html>") });
    expect(screenOf(await submitUpload(html.handler, html.characterId)).content).toBe("That does not look like a PNG, JPG or WebP picture.");
    const gone = await table(r, { downloaded: "fail" });
    expect(screenOf(await submitUpload(gone.handler, gone.characterId)).content).toContain("could not be read from Discord");
    const none = await table(r);
    const empty = screenOf(await submitUpload(none.handler, none.characterId, { uploads: {} }));
    expect(empty.content).toContain("No picture came with the form");
    expect(empty.buttons[0]?.label).toBe("Back");
    const huge = await table(r);
    expect(screenOf(await submitUpload(huge.handler, huge.characterId, { uploads: { file: [{ ...upload, size: 9 * 1024 * 1024 }] } })).content).toContain("over 8 MB");
    const failing = await table(r);
    failing.stylizer.fail = true;
    expect(screenOf(await submitUpload(failing.handler, failing.characterId)).content).toContain("could not be made this time");
  });

  it("only offers painting from the description when the bot cannot edit pictures", async () => {
    const r = rig();
    const { handler, characterId } = await table(r, { stylizer: false });
    const home = screenOf(await click(handler, libraryCustomId("pHome", characterId)));
    expect(home.buttons.map((button) => button.label)).toEqual(["Paint from description", "Back"]);
    expect(home.content).toContain("Uploading needs an image model");
  });

  it("gives nobody else the portrait screens of someone's character, and forgets the portrait with the character", async () => {
    const r = rig();
    const { handler, portraits, store, characterId } = await table(r);
    expect(screenOf(await click(handler, libraryCustomId("pHome", characterId), "u-bob")).content).toBe("That character is not in your library.");
    expect(screenOf(await submitUpload(handler, characterId, { userId: "u-bob" })).content).toBe("That character is no longer in your library.");
    await click(handler, libraryCustomId("pPaint", characterId));
    await click(handler, libraryCustomId("pUse", characterId));
    expect((await portraits.forGame(characterId))?.bytes.toString()).toBe("painted");
    await click(handler, libraryCustomId("deleteYes", characterId));
    expect(store.images.size).toBe(0);
  });

  it("speaks Traditional Chinese to a person whose Discord is in Chinese", async () => {
    const r = rig();
    const { handler, characterId } = await table(r);
    const home = screenOf(await click(handler, libraryCustomId("pHome", characterId), "u-alice", { locale: "zh-TW" }));
    expect(home.content).toContain("**Aldric 的頭像**");
    expect(home.buttons.map((button) => button.label)).toEqual(["上傳圖片", "依描述生成", "返回"]);
  });
});
