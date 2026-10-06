import { describe, expect, it } from "vitest";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { srd51GeneratedItems } from "../../../src/domain/campaign/content/srd-5.1/items/srd-equipment.generated.js";
import { ruleset } from "./campaign-fixtures.js";

const { content } = ruleset();

describe("the SRD equipment list", () => {
  it.each(srd51GeneratedItems.map((item) => item.id))("%s is in the ruleset and named in both languages", (id) => {
    expect(content.find(id)?.kind).toBe("item");
    expect(enSrd51Glossary.names[id], "en").toBeTruthy();
    expect(zhTwSrd51Glossary.names[id], "zh-TW").toBeTruthy();
  });

  it("prices gear in copper and keeps the musical horn apart from the beast's", () => {
    const rope = content.get("item:rope-hempen-50-feet");
    expect(rope.itemType === "gear" && rope.costCp).toBe(100);
    expect(content.get("item:horn-instrument").itemType).toBe("gear");
    expect(content.get("item:horn").itemType).toBe("weapon");
  });
});
