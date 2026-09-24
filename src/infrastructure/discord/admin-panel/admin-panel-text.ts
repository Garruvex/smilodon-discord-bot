import {
  commandDescriptionCatalogs,
  commandDescriptionKey,
} from "../../../application/i18n/command-descriptions/index.js";
import type { Language } from "../../../application/i18n/language.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import type { PanelSectionLayout } from "../settings/panel-layout.js";

export interface AdminPanelText {
  ui: Texts["admin"]["panel"];
  // A row's explanation is its option's slash-command description, so the
  // translated description catalogs cover the panel too.
  optionDescription(groupName: string, settingName: string, optionName: string, english: string): string;
  groupDescription(section: PanelSectionLayout, english: string): string;
  label(english: string): string;
  sectionTitle(section: PanelSectionLayout): string;
}

export function adminPanelText(language: Language): AdminPanelText {
  const catalog = commandDescriptionCatalogs[language];
  const described = (key: string, english: string): string => catalog?.[key] ?? english;
  return {
    ui: texts[language].admin.panel,
    optionDescription: (groupName, settingName, optionName, english) =>
      described(commandDescriptionKey([`settings-${groupName}`, settingName], optionName), english),
    groupDescription: (section, english) => described(commandDescriptionKey([`settings-${section.groupName}`]), english),
    // Row labels and section titles aren't translated yet; they come from
    // the settings registry in English.
    label: (english) => english,
    sectionTitle: (section) => section.title,
  };
}
