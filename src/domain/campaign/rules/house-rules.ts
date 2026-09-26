import type { NaturalRollRule } from "../dice/d20-test.js";

// A house-rule option: an enumerated choice the engine implements every
// value of. Engine code reads options through the typed option object, never
// by string lookup.
export interface HouseRuleOption<V extends string> {
  readonly id: string;
  readonly values: readonly V[];
  readonly defaultValue: V;
}

export const naturalRollsOnChecks: HouseRuleOption<NaturalRollRule> = {
  id: "natural-rolls-on-checks",
  values: ["no-effect", "automatic"],
  defaultValue: "no-effect",
};

// Plan §5, Away mode: an away hero cannot die while the player is gone.
export const awaySafety: HouseRuleOption<"protected" | "standard"> = {
  id: "away-safety",
  values: ["protected", "standard"],
  defaultValue: "protected",
};

// Plan §5: drinking a healing potion takes an action (2014 rules) or a bonus action (BG3-style).
export const healingPotionCost: HouseRuleOption<"action" | "bonus-action"> = {
  id: "healing-potion-cost",
  values: ["action", "bonus-action"],
  defaultValue: "action",
};

// Who plays the heroes in a fight. "players": each present player takes their
// hero's turns. "autopilot": the engine plays every hero on cautious autopilot
// (Dodge, or a basic attack on a foe already engaging them; no limited
// resources), for tables that want the story without the tactics.
export const combatMode: HouseRuleOption<"players" | "autopilot"> = {
  id: "combat-mode",
  values: ["players", "autopilot"],
  defaultValue: "players",
};

// Where a fight's gold goes. The 2014 rules leave treasure to the table:
// "pooled" keeps it in one party purse; "split" shares it evenly between the
// heroes still standing (any remainder to the first in party order), and each
// hero keeps their own coins.
export const lootGold: HouseRuleOption<"pooled" | "split"> = {
  id: "loot-gold",
  values: ["pooled", "split"],
  defaultValue: "pooled",
};

// Plan §4, Critical hits. "double-dice" is the 2014 rule (every damage die is
// rolled twice). "max-first-die" takes the maximum on the first damage die and
// rolls the rest once: a critical that never rolls low, with less swing.
export const criticalHits: HouseRuleOption<"double-dice" | "max-first-die"> = {
  id: "critical-hits",
  values: ["double-dice", "max-first-die"],
  defaultValue: "double-dice",
};

// Plan §4, Item trading. "consent": heroes give or swap items with the
// receiver's yes (the party stash always works). "off": nobody hands items to
// another hero; the stash is the way to share.
export const itemTrading: HouseRuleOption<"consent" | "off"> = {
  id: "item-trading",
  values: ["consent", "off"],
  defaultValue: "consent",
};

export const houseRuleOptions: readonly HouseRuleOption<string>[] = [
  naturalRollsOnChecks,
  awaySafety,
  healingPotionCost,
  combatMode,
  lootGold,
  criticalHits,
  itemTrading,
];

// A named bundle of option values (plan §4). Applying one sets exactly the
// options it lists and leaves the others as they are.
export interface HouseRulePreset {
  readonly id: string;
  readonly values: Readonly<Record<string, string>>;
}

// "standard" is every 2014 rule at its default. "bg3" is only what the
// plan documents for Baldur's Gate 3 and the engine implements: drinking a
// potion as a bonus action. More of it waits for the rules to be confirmed.
export const houseRulePresets: readonly HouseRulePreset[] = [
  {
    id: "standard",
    values: { [naturalRollsOnChecks.id]: "no-effect", [healingPotionCost.id]: "action", [criticalHits.id]: "double-dice", [itemTrading.id]: "consent" },
  },
  { id: "bg3", values: { [healingPotionCost.id]: "bonus-action" } },
];

// The option values a campaign saved, validated and with defaults filled in.
export interface HouseRules {
  option<V extends string>(option: HouseRuleOption<V>): V;
}

export class HouseRuleError extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`Invalid house rules:\n- ${problems.join("\n- ")}`);
    this.name = "HouseRuleError";
  }
}

export function resolveHouseRules(saved: Readonly<Record<string, string>>): HouseRules {
  const known = new Map(houseRuleOptions.map((option) => [option.id, option]));
  const problems: string[] = [];
  for (const [id, value] of Object.entries(saved)) {
    const option = known.get(id);
    if (option === undefined) problems.push(`Unknown house-rule option "${id}".`);
    else if (!option.values.includes(value)) problems.push(`Option "${id}" does not allow "${value}".`);
  }
  if (problems.length > 0) throw new HouseRuleError(problems);
  const values = Object.freeze({ ...saved });
  return {
    option<V extends string>(option: HouseRuleOption<V>): V {
      // Validated above: a saved value is always one of the option's values.
      return (values[option.id] as V | undefined) ?? option.defaultValue;
    },
  };
}
