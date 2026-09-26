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

export const houseRuleOptions: readonly HouseRuleOption<string>[] = [naturalRollsOnChecks];

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
