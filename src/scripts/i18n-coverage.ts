import { languageDisplayNames, languages } from "../application/i18n/language.js";
import { en } from "../application/i18n/messages/en.js";
import { catalogIssues, untranslatedKeys } from "../application/i18n/texts.js";

// Prints, per language, which runtime messages still show in English, and any
// catalog errors. Untranslated messages are expected while a translation is in
// progress (English fills in), so only catalog errors fail the command.
const total = Object.keys(en).length;

for (const language of languages) {
  if (language === "en") continue;
  const missing = untranslatedKeys[language];
  const translated = total - missing.length;
  process.stdout.write(
    `${language} (${languageDisplayNames[language]}): ${translated}/${total} translated` +
      (missing.length > 0 ? `, ${missing.length} showing in English:\n` : "\n"),
  );
  for (const key of missing) process.stdout.write(`  - ${key}\n`);
}

if (catalogIssues.length > 0) {
  process.stderr.write(`\n${catalogIssues.length} catalog error(s) — these messages show in English until fixed:\n`);
  for (const issue of catalogIssues) {
    process.stderr.write(`  - [${issue.language}] ${issue.key} ${issue.problem}\n`);
  }
  process.exitCode = 1;
}
