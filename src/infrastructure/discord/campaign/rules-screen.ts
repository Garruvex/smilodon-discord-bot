import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

import type { Texts } from "../../../application/i18n/texts.js";
import { houseRuleOptions, houseRulePresets, type HouseRuleOption } from "../../../domain/campaign/rules/house-rules.js";
import { campaignCustomId } from "./campaign-ids.js";

// "healing-potion-cost" is the text key "healingPotionCost".
const camel = (id: string): string => id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

interface OptionTexts {
  readonly name: string;
  readonly info: string;
  readonly value: (value: string) => string;
}

// The words for an option and each of its values, from the message catalog.
export function optionTexts(text: Texts, option: HouseRuleOption<string>): OptionTexts {
  const options = text.campaign.rules.opt as unknown as Readonly<Record<string, Readonly<Record<string, string>>>>;
  const messages = options[camel(option.id)] ?? {};
  return { name: messages.name ?? option.id, info: messages.info ?? "", value: (value) => messages[camel(value)] ?? value };
}

export function presetName(text: Texts, id: string): string {
  const names = text.campaign.rules.preset as unknown as Readonly<Record<string, string>>;
  return names[id] ?? id;
}

// One line per option with the value in force (a saved value, or the default).
export function ruleLines(text: Texts, saved: Readonly<Record<string, string>>): readonly string[] {
  return houseRuleOptions.map((option) => {
    const words = optionTexts(text, option);
    return text.campaign.rules.line({ name: words.name, value: words.value(saved[option.id] ?? option.defaultValue) });
  });
}

export interface RulesScreenInput {
  readonly campaignId: string;
  readonly houseRules: Readonly<Record<string, string>>;
  // The organizer, before the game starts.
  readonly editable: boolean;
  // The option whose values are on offer.
  readonly selected: string | null;
  readonly text: Texts;
}

export interface RulesScreen {
  readonly content: string;
  readonly components: ActionRowBuilder<StringSelectMenuBuilder>[];
}

// The private Table rules screen: every option with its value, and (for the
// organizer, before start) a bundle picker, an option picker, and the values
// of the option picked. Choosing only saves a value the engine implements.
export function renderRulesScreen(input: RulesScreenInput): RulesScreen {
  const { text, campaignId, houseRules } = input;
  const t = text.campaign.rules;
  const content = [`**${t.title}**`, input.editable ? t.intro : t.readOnly, "", ...ruleLines(text, houseRules)].join("\n");
  if (!input.editable) return { content, components: [] };

  const presets = new StringSelectMenuBuilder()
    .setCustomId(campaignCustomId("rulePreset", campaignId))
    .setPlaceholder(t.presetPlaceholder)
    .addOptions(houseRulePresets.map((preset) => ({ label: presetName(text, preset.id), value: preset.id })));
  const chosen = houseRuleOptions.find((option) => option.id === input.selected);
  const picker = new StringSelectMenuBuilder()
    .setCustomId(campaignCustomId("ruleOption", campaignId))
    .setPlaceholder(t.optionPlaceholder)
    .addOptions(houseRuleOptions.map((option) => ({ label: optionTexts(text, option).name, value: option.id, default: option.id === chosen?.id })));
  const rows = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(presets), new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker)];
  if (chosen !== undefined) {
    const words = optionTexts(text, chosen);
    const current = houseRules[chosen.id] ?? chosen.defaultValue;
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(campaignCustomId("ruleValue", campaignId, chosen.id))
          .setPlaceholder(`${words.name}: ${t.valuePlaceholder}`.slice(0, 150))
          .addOptions(chosen.values.map((value) => ({ label: words.value(value).slice(0, 100), value, default: value === current }))),
      ),
    );
    return { content: `${content}\n\n*${words.name}: ${words.info}*`, components: rows };
  }
  return { content, components: rows };
}
