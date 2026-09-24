import { isLanguage, languageDisplayNames, languages } from "../../../../application/i18n/language.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const languageSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "language",
  description: "Sets the language for translated bot messages in this server.",
  configureOptions: () => [
    {
      type: "string",
      name: "language",
      description: "The language to use.",
      required: true,
      choices: languages.map((language) => ({ name: languageDisplayNames[language], value: language })),
    },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    const language = request.values.getString("language", true);
    if (!isLanguage(language)) {
      return Promise.resolve({ ok: false, message: `"${language}" isn't a supported language.` });
    }
    input.language = language;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "Language", read: (p) => languageDisplayNames[p.language] }],
};
