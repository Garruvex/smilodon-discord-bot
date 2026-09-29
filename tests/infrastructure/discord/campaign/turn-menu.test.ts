import { describe, expect, it } from "vitest";

import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { TurnView } from "../../../../src/application/campaign/views/turn-view.js";
import { texts } from "../../../../src/application/i18n/texts.js";
import { encodeAim, encodeChoice, parseAim, parseChoice, renderEndConfirm, renderTargetMenu, renderTurnMenu, type TurnChoice } from "../../../../src/infrastructure/discord/campaign/turn-menu.js";

const goblin = { id: "goblin-a", name: "Goblin A", zone: "Yard", side: "foes", hp: 5, maxHp: 7, band: "bloodied", self: false } as const;
const ally = { id: "c-mira", name: "Mira", zone: "Yard", side: "party", hp: 6, maxHp: 9, band: "hurt", self: false } as const;

const view: TurnView = {
  combatantId: "c-elin",
  heroName: "Elin",
  zone: "Yard",
  budget: { action: true, bonusAction: true, reaction: true, movement: 30, attacksLeft: 1, bonusSpellCast: false },
  engagedWith: ["Goblin A"],
  busy: false,
  attacks: [{ weapon: "item:mace", toHit: 4, damage: "1d6+2", ranged: false, targets: [goblin] }],
  spells: [
    { spellId: "spell:sacred-flame", slotLevel: 0, slotsLeft: 0, bonusAction: false, maxTargets: 1, targets: [goblin] },
    { spellId: "spell:bless", slotLevel: 1, slotsLeft: 2, bonusAction: false, maxTargets: 3, targets: [ally, { ...ally, id: "c-elin", name: "Elin", self: true }] },
  ],
  features: [],
  potions: [{ id: "item:potion-of-healing", count: 2, bonusAction: false }],
  shields: [{ id: "item:shield", on: true }],
  moves: [{ zoneId: "gate", zone: "Gate", feet: 10 }],
  engage: [],
  canWithdraw: true,
  canDodge: true,
  canDashOrDisengage: true,
  hasUnspent: true,
};

const json = (menu: { components: readonly { toJSON(): unknown }[] }): Record<string, unknown>[] =>
  menu.components.flatMap((row) => (row.toJSON() as { components: Record<string, unknown>[] }).components);

describe("the turn menu", () => {
  it("round-trips every choice through its option value, and rejects junk", () => {
    const choices: TurnChoice[] = [
      { kind: "attack", weapon: "item:mace" },
      { kind: "cast", spell: "spell:bless", slot: 1 },
      { kind: "feature", feature: "feature:second-wind" },
      { kind: "potion", item: "item:potion-of-healing" },
      { kind: "move", zone: "gate" },
      { kind: "engage" },
      { kind: "withdraw" },
      { kind: "dodge" },
      { kind: "dash" },
      { kind: "disengage" },
      { kind: "end" },
    ];
    for (const choice of choices) {
      expect(parseChoice(encodeChoice(choice))).toEqual(choice);
      expect(parseAim(encodeAim(choice, "goblin-a"))).toEqual({ choice, targetId: "goblin-a" });
    }
    for (const junk of ["", "attack", "attack|spell:x", "cast|spell:bless|-1", "cast|spell:bless|x", "dance", "move|"]) expect(parseChoice(junk)).toBeNull();
    expect(parseAim("dodge")).toBeNull();
    expect(parseAim("dodge>")).toBeNull();
    expect(encodeAim({ kind: "attack", weapon: "item:mace" }, "goblin-a").length).toBeLessThan(100);
  });

  it("lists each legal action once, ending with End turn, with readable labels", () => {
    const menu = renderTurnMenu(view, texts.en, enSrd51Glossary, "camp");
    expect(menu.content).toContain("**Elin** · Yard");
    expect(menu.content).toContain("Action ✅ · Bonus action ✅ · Reaction ✅ · Movement 30 ft");
    expect(menu.content).toContain("In melee with Goblin A.");
    const select = json(menu).find((component) => Array.isArray(component.options));
    const labels = (select?.options as { label: string }[]).map((option) => option.label);
    expect(labels[0]).toBe("Attack with Mace (+4, 1d6+2)");
    expect(labels).toContain("Cast Sacred Flame (cantrip)");
    expect(labels).toContain("Cast Bless (level 1 slot, 2 left)");
    expect(labels).toContain("Drink Potion of Healing (×2)");
    expect(labels).toContain("Move to Gate (10 ft)");
    expect(labels).toContain("Take off Shield (action)");
    expect(labels).toContain("Step back from melee");
    expect(labels.at(-1)).toBe("End turn");
    expect(labels).toHaveLength(new Set(labels).size);
  });

  it("aims at the legal targets only, allowing several for a spell that has several", () => {
    const single = renderTargetMenu({ kind: "attack", weapon: "item:mace" }, view, texts.en, enSrd51Glossary, "camp");
    const select = single === null ? undefined : json(single).find((component) => Array.isArray(component.options));
    expect(select?.max_values).toBe(1);
    expect((select?.options as { label: string; value: string }[]).map((option) => option.label)).toEqual(["Goblin A · Yard, bloodied"]);

    const bless = renderTargetMenu({ kind: "cast", spell: "spell:bless", slot: 1 }, view, texts.en, enSrd51Glossary, "camp");
    const many = bless === null ? undefined : json(bless).find((component) => Array.isArray(component.options));
    expect(many?.max_values).toBe(2);
    expect((many?.options as { label: string }[]).map((option) => option.label)).toEqual(["Mira · 6/9 HP", "Elin (you)"]);
    expect(bless?.content).toContain("choose up to 2 targets");

    // A choice that is not in the view (stale) has no menu.
    expect(renderTargetMenu({ kind: "attack", weapon: "item:longsword" }, view, texts.en, enSrd51Glossary, "camp")).toBeNull();
    expect(renderTargetMenu({ kind: "dodge" }, view, texts.en, enSrd51Glossary, "camp")).toBeNull();
  });

  it("lists a spell at every slot level it could be upcast to, as separate choices", () => {
    const upcastable: TurnView = {
      ...view,
      spells: [...view.spells, { spellId: "spell:bless", slotLevel: 2, slotsLeft: 1, bonusAction: false, maxTargets: 3, targets: [ally] }],
    };
    const menu = renderTurnMenu(upcastable, texts.en, enSrd51Glossary, "camp");
    const select = json(menu).find((component) => Array.isArray(component.options));
    const options = select?.options as { label: string; value: string }[];
    expect(options.map((option) => option.label)).toContain("Cast Bless (level 1 slot, 2 left)");
    expect(options.map((option) => option.label)).toContain("Cast Bless (level 2 slot, 1 left)");
    expect(options.map((option) => option.value)).toEqual(expect.arrayContaining(["cast|spell:bless|1", "cast|spell:bless|2"]));

    // Each level targets and answers independently.
    const atOne = renderTargetMenu({ kind: "cast", spell: "spell:bless", slot: 1 }, upcastable, texts.en, enSrd51Glossary, "camp");
    const atTwo = renderTargetMenu({ kind: "cast", spell: "spell:bless", slot: 2 }, upcastable, texts.en, enSrd51Glossary, "camp");
    const optionsAtOne = atOne === null ? undefined : json(atOne).find((component) => Array.isArray(component.options));
    const optionsAtTwo = atTwo === null ? undefined : json(atTwo).find((component) => Array.isArray(component.options));
    expect(optionsAtOne?.max_values).toBe(2);
    expect(optionsAtTwo?.max_values).toBe(1);
  });

  it("only offers Refresh while an attack is being resolved", () => {
    const menu = renderTurnMenu({ ...view, busy: true }, texts.en, enSrd51Glossary, "camp");
    expect(menu.content).toContain("Your action is being resolved");
    expect(json(menu).map((component) => component.custom_id)).toEqual(["dnd:turnRefresh:camp"]);
  });

  it("stays within Discord's limits with many choices, and speaks Traditional Chinese", () => {
    const crowded: TurnView = { ...view, moves: Array.from({ length: 30 }, (_, index) => ({ zoneId: `z${index}`, zone: `Zone ${index}`, feet: 5 })) };
    const select = json(renderTurnMenu(crowded, texts.en, enSrd51Glossary, "camp")).find((component) => Array.isArray(component.options));
    expect((select?.options as unknown[]).length).toBe(25);
    expect(((select?.options as { value: string }[]).at(-1))?.value).toBe("end");

    const zh = renderTurnMenu(view, texts["zh-TW"], zhTwSrd51Glossary, "camp");
    expect(zh.content).toContain("動作 ✅");
    const labels = (json(zh).find((component) => Array.isArray(component.options))?.options as { label: string }[]).map((option) => option.label);
    expect(labels.at(-1)).toBe("結束回合");
    expect(json(renderEndConfirm(texts["zh-TW"], "camp")).map((component) => component.label)).toEqual(["仍然結束回合", "返回"]);
  });
});
