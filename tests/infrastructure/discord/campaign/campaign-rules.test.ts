import { describe, expect, it } from "vitest";

import { houseRuleOptions } from "../../../../src/domain/campaign/rules/house-rules.js";
import { quiet, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { contentOf, fakeInteraction, harness, heroes, started, type Harness, type Sent } from "./handler-harness.js";

interface Row {
  readonly id: string;
  readonly options: readonly { value: string; label: string; default?: boolean }[];
}

function selects(sent: readonly Sent[]): Row[] {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const rows = (last?.payload as { components?: { toJSON(): { components: Record<string, unknown>[] } }[] } | undefined)?.components ?? [];
  return rows.flatMap((row) => row.toJSON().components.map((component) => ({ id: String(component.custom_id), options: (component.options ?? []) as Row["options"] })));
}

async function choose(t: Harness, action: "rulePreset" | "ruleOption" | "ruleValue", value: string, userId = "u-org", argument?: string): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId: `dnd:${action}:${t.key.campaignId}${argument === undefined ? "" : `:${argument}`}`, userId, values: [value], kind: "select" });
  await t.handler.execute({ interaction, logger: quiet as never });
  return sent;
}

const savedRules = async (t: Harness): Promise<Readonly<Record<string, string>>> => (await t.r.service.get(t.key))?.record.houseRules ?? {};

describe("the Table rules screen", () => {
  it("lists every option with its value, and offers the organizer a bundle picker and an option picker", async () => {
    const t = await harness();
    const sent = await t.press("rules", "u-org");
    const content = contentOf(sent);
    expect(content).toContain("Change how this game plays before it starts");
    // Every option the engine implements has a line, with the value in force.
    expect(content).toContain("**Critical hits:** Damage dice are rolled twice (2014 rules)");
    expect(content).toContain("**Drinking a healing potion:** An action (2014 rules)");
    expect(content.split("\n").filter((line) => line.startsWith("**"))).toHaveLength(houseRuleOptions.length + 1);
    const rows = selects(sent);
    expect(rows.map((row) => row.id.split(":")[1])).toEqual(["rulePreset", "ruleOption"]);
    expect(rows[1]?.options.map((option) => option.value)).toEqual(houseRuleOptions.map((option) => option.id));
  });

  it("shows anyone else the same rules to read, and nothing to change", async () => {
    const t = await harness();
    await t.press("join", "u-two");
    const sent = await t.press("rules", "u-two");
    expect(contentOf(sent)).toContain("Only the organizer can change these");
    expect(contentOf(sent)).toContain("**Critical hits:**");
    expect(selects(sent)).toEqual([]);
  });

  it("saves the value picked for an option, then shows it", async () => {
    const t = await harness();
    const picked = await choose(t, "ruleOption", "critical-hits");
    const values = selects(picked).find((row) => row.id.includes("ruleValue"));
    expect(values?.id).toBe(`dnd:ruleValue:${t.key.campaignId}:critical-hits`);
    expect(values?.options.map((option) => [option.value, option.default])).toEqual([["double-dice", true], ["max-first-die", false]]);
    // Nothing is saved by looking.
    expect(await savedRules(t)).not.toHaveProperty("critical-hits");

    const saved = await choose(t, "ruleValue", "max-first-die", "u-org", "critical-hits");
    expect(contentOf(saved)).toContain("**Critical hits:** First die is its maximum, the rest rolled once");
    expect((await savedRules(t))["critical-hits"]).toBe("max-first-die");
    expect(selects(saved).find((row) => row.id.includes("ruleValue"))?.options.find((option) => option.default)?.value).toBe("max-first-die");
  });

  it("applies a bundle, and leaves the options it does not list alone", async () => {
    const t = await harness();
    await choose(t, "ruleValue", "max-first-die", "u-org", "critical-hits");
    await choose(t, "ruleValue", "off", "u-org", "item-trading");
    await choose(t, "rulePreset", "bg3");
    expect(await savedRules(t)).toMatchObject({ "healing-potion-cost": "bonus-action", "critical-hits": "max-first-die", "item-trading": "off" });
    // Standard puts every 2014 rule back.
    await choose(t, "rulePreset", "standard");
    expect(await savedRules(t)).toMatchObject({ "healing-potion-cost": "action", "critical-hits": "double-dice", "item-trading": "consent", "natural-rolls-on-checks": "no-effect" });
  });

  it("refuses a change from anyone but the organizer, and a value the engine does not have", async () => {
    const t = await harness();
    await t.press("join", "u-two");
    expect(contentOf(await choose(t, "ruleValue", "off", "u-two", "item-trading"))).toBe("Only the organizer can do that.");
    expect(await savedRules(t)).not.toHaveProperty("item-trading");
    expect(contentOf(await choose(t, "ruleValue", "triple", "u-org", "critical-hits"))).not.toContain("Critical hits");
    expect(contentOf(await choose(t, "ruleValue", "off", "u-org", "not-an-option"))).not.toContain("Critical hits");
    expect(await savedRules(t)).not.toHaveProperty("critical-hits");
  });

  it("is fixed once the game starts: the choices are pinned to the campaign, and More… shows them read-only", async () => {
    const t = await harness();
    await choose(t, "ruleValue", "bonus-action", "u-org", "healing-potion-cost");
    await started(t);
    const pinned = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(pinned?.ruleset.houseRules).toMatchObject({ "healing-potion-cost": "bonus-action" });

    expect(contentOf(await choose(t, "ruleValue", "action", "u-org", "healing-potion-cost"))).toBe("This campaign is no longer in the lobby.");
    expect((await savedRules(t))["healing-potion-cost"]).toBe("bonus-action");
    const more = contentOf(await t.press("more", "u-org"));
    expect(more).toContain("How to play");
    expect(more).toContain("**Drinking a healing potion:** A bonus action");
  });

  it("speaks Traditional Chinese for a Chinese game", async () => {
    const t = await harness("zh-TW");
    const sent = await t.press("rules", "u-org");
    expect(contentOf(sent)).toContain("**重擊：**傷害骰擲兩次（2014 規則）");
    expect(selects(sent)[1]?.options.map((option) => option.label)).toContain("喝治療藥水");
  });

  it("has words in both languages for every option, value and bundle", async () => {
    const { texts } = await import("../../../../src/application/i18n/texts.js");
    const { optionTexts, presetName } = await import("../../../../src/infrastructure/discord/campaign/rules-screen.js");
    const { houseRulePresets } = await import("../../../../src/domain/campaign/rules/house-rules.js");
    for (const language of ["en", "zh-TW"] as const) {
      for (const option of houseRuleOptions) {
        const words = optionTexts(texts[language], option);
        expect(words.name, `${option.id} name`).not.toBe(option.id);
        expect(words.info, `${option.id} info`).not.toBe("");
        for (const value of option.values) expect(words.value(value), `${option.id}=${value}`).not.toBe(value);
      }
      for (const preset of houseRulePresets) expect(presetName(texts[language], preset.id)).not.toBe(preset.id);
    }
    expect(heroes.length).toBeGreaterThan(0);
  });
});

describe("item trading turned off", () => {
  it("takes Give out of the pack menu and refuses a gift, while the stash still works", async () => {
    const t = await harness();
    await t.press("join", "u-org");
    await t.select("u-org", heroes[0]?.id ?? "");
    await t.press("join", "u-two");
    await t.select("u-two", heroes[1]?.id ?? "");
    await choose(t, "ruleValue", "off", "u-org", "item-trading");
    await t.press("start", "u-org");
    await tellOpening(t.r, t.key);
    await t.cards.sync(t.key);

    const packValues = (sent: readonly Sent[]): string[] => {
      const last = [...sent].reverse().find((entry) => entry.kind === "edit");
      const rows = (last?.payload as { components?: { toJSON(): { components: { custom_id?: string; options?: { value: string }[] }[] } }[] } | undefined)?.components ?? [];
      return rows.flatMap((row) => row.toJSON().components.filter((component) => component.custom_id?.startsWith("dnd:pack:") === true).flatMap((component) => (component.options ?? []).map((option) => option.value)));
    };
    const values = packValues(await t.press("myHero", "u-org"));
    expect(values.some((value) => value.startsWith("stash|"))).toBe(true);
    expect(values.some((value) => value.startsWith("give|"))).toBe(false);
  });
});
