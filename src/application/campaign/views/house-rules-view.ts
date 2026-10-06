import type { Texts } from "../../i18n/texts.js";
import { houseRuleOptions, houseRulePresets } from "../../../domain/campaign/rules/house-rules.js";

// The table's house rules as the page shows them: every option with the value in force and, for the organizer before the game starts,
// the values on offer. The words come from the same catalog the Discord rules screen reads.
export interface HouseRulesView {
  readonly editable: boolean;
  readonly presets: readonly { readonly id: string; readonly name: string }[];
  readonly options: readonly {
    readonly id: string;
    readonly name: string;
    readonly info: string;
    readonly value: string;
    readonly values: readonly { readonly id: string; readonly label: string }[];
  }[];
}

// "healing-potion-cost" is the text key "healingPotionCost".
const camel = (id: string): string => id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function buildHouseRulesView(text: Texts, saved: Readonly<Record<string, string>>, editable: boolean): HouseRulesView {
  const options = text.campaign.rules.opt as unknown as Readonly<Record<string, Readonly<Record<string, string>>>>;
  const presets = text.campaign.rules.preset as unknown as Readonly<Record<string, string>>;
  return {
    editable,
    presets: houseRulePresets.map((preset) => ({ id: preset.id, name: presets[preset.id] ?? preset.id })),
    options: houseRuleOptions.map((option) => {
      const words = options[camel(option.id)] ?? {};
      const label = (value: string): string => words[camel(value)] ?? value;
      return { id: option.id, name: words.name ?? option.id, info: words.info ?? "", value: saved[option.id] ?? option.defaultValue, values: option.values.map((value) => ({ id: value, label: label(value) })) };
    }),
  };
}
