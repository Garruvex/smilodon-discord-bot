import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { resolveHouseRules } from "../../../domain/campaign/rules/house-rules.js";
import type { SealedRuleset } from "../../../domain/campaign/rules/ruleset.js";
import type { RulesetPin } from "../ports/campaign-store.js";

export class UnknownRulesetError extends Error {
  public constructor(pin: RulesetPin) {
    super(`No ruleset ${pin.rulesetId}@${pin.rulesetVersion} is installed.`);
    this.name = "UnknownRulesetError";
  }
}

// The sealed content versions this process can run, built once at startup.
// A campaign pinned to a version that is not installed fails loudly rather
// than running under different rules.
export class RulesetCatalog {
  private readonly contents = new Map<string, SealedContent>();

  public constructor(contents: readonly SealedContent[]) {
    for (const content of contents) this.contents.set(pinKey(content.rulesetId, content.version), content);
  }

  public resolve(pin: RulesetPin): SealedRuleset {
    const content = this.contents.get(pinKey(pin.rulesetId, pin.rulesetVersion));
    if (content === undefined) throw new UnknownRulesetError(pin);
    return { content, houseRules: resolveHouseRules(pin.houseRules) };
  }
}

export function pinKey(rulesetId: string, version: string): string {
  return `${rulesetId}@${version}`;
}
