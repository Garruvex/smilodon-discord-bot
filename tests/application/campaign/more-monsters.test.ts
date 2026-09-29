import { describe, expect, it } from "vitest";

import { rehearseEncounter } from "../../../src/application/campaign/adventures/adventure-smoke.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { srd51MoreMonsters } from "../../../src/domain/campaign/content/srd-5.1/monsters/more-monsters.js";
import { srd51GeneratedMonsters } from "../../../src/domain/campaign/content/srd-5.1/monsters/srd-monsters.generated.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";
import { starter } from "./campaign-rig.js";

const { content } = ruleset();
const base = starter.en.bible.encounters[0];

// A cloud that cannot hurt anyone and regenerates faster than a party can wound it: no fight with it ends.
const stalemates = new Set(["monster:vampire-mist"]);

describe("the wider monster roster", () => {
  it.each([...srd51MoreMonsters, ...srd51GeneratedMonsters].map((monster) => monster.id).filter((id) => !stalemates.has(id)))("%s has a name in both languages and can be fought to an end", (id) => {
    if (base === undefined) throw new Error("encounter");
    expect(enSrd51Glossary.names[id], "en").toBeTruthy();
    expect(zhTwSrd51Glossary.names[id], "zh-TW").toBeTruthy();
    const encounter = { ...base, monsters: [{ monsterId: id, zoneId: base.monsters[0]?.zoneId ?? base.partyZoneId, npcId: null, fleeBelowHpFraction: null }] };
    for (const seed of [1, 2]) {
      const result = rehearseEncounter(starter.en, encounter, content, seed);
      expect(result.problem, `${id} seed ${seed}`).toBeNull();
    }
  });
});
