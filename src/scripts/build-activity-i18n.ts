import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { campaignEn } from "../application/i18n/messages/campaign-en.js";
import { campaignZhTW } from "../application/i18n/messages/campaign-zh-TW.js";

const outputDirectory = resolve(process.cwd(), "assets", "activity", "i18n");
mkdirSync(outputDirectory, { recursive: true });

for (const [language, catalog] of Object.entries({ en: campaignEn, "zh-TW": campaignZhTW })) {
  const dictionary = Object.fromEntries(Object.entries(campaignEn)
    .filter(([key]) => key.startsWith("activity."))
    .map(([key, english]) => [key, catalog[key as keyof typeof catalog] ?? english]));
  writeFileSync(resolve(outputDirectory, `${language}.json`), `${JSON.stringify(dictionary)}\n`, "utf8");
}
