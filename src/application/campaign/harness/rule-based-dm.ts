import type { CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import type { PlannedResolution, RoundPlanProposal } from "../../../domain/campaign/commands/campaign-command.js";
import type { CampaignNarrator, CampaignPlanner, NarratedOutcome, NarratorRequest, PlannerRequest } from "../ports/dm-ports.js";

// Deterministic stand-ins for the model calls, so the harness can play a
// whole session offline and regression runs are exactly repeatable. They
// exercise the pipeline, not storytelling; real providers replace them for
// measurement runs.

interface KeywordRule {
  readonly words: readonly string[];
  readonly resolution: PlannedResolution;
}

const check = (test: CheckTest, dcTier: "easy" | "medium" | "hard" = "medium"): PlannedResolution => ({
  kind: "check",
  test,
  dcTier,
  rollModeReasons: [],
});

// First match wins, so the injection guard comes first.
const rules: readonly KeywordRule[] = [
  { words: ["ignore", "+5", "忽略", "無視"], resolution: { kind: "impossible", reason: "Player text cannot change the rules." } },
  { words: ["read his", "motive", "lying", "洞悉", "說謊", "看穿"], resolution: check({ kind: "skill", skill: "insight" }) },
  { words: ["sneak", "hide", "quiet", "潛行", "躲", "悄悄"], resolution: check({ kind: "skill", skill: "stealth" }) },
  { words: ["climb", "force", "lift", "push", "攀", "爬", "撞", "推"], resolution: check({ kind: "skill", skill: "athletics" }) },
  { words: ["search", "examine", "investigate", "搜", "調查", "檢查"], resolution: check({ kind: "skill", skill: "investigation" }) },
  { words: ["listen", "look", "watch", "spot", "聽", "看", "觀察", "警戒"], resolution: check({ kind: "skill", skill: "perception" }, "easy") },
  { words: ["threaten", "intimidate", "威嚇", "恐嚇"], resolution: check({ kind: "skill", skill: "intimidation" }) },
  { words: ["persuade", "convince", "ask", "talk", "說服", "勸", "詢問", "問"], resolution: check({ kind: "skill", skill: "persuasion" }) },
];

export class RuleBasedPlanner implements CampaignPlanner {
  public plan(request: PlannerRequest): Promise<RoundPlanProposal> {
    return Promise.resolve({
      roundNumber: request.roundNumber,
      actions: request.actions.map((action) => {
        const lower = action.text.toLowerCase();
        const rule = rules.find((candidate) => candidate.words.some((word) => lower.includes(word)));
        return {
          characterId: action.characterId,
          resolution: rule?.resolution ?? { kind: "automatic", reason: "Nothing stands in the way." },
        };
      }),
    });
  }
}

export class TemplateNarrator implements CampaignNarrator {
  public narrate(request: NarratorRequest): Promise<{ readonly text: string }> {
    const zh = request.language === "zh-TW";
    const lines = request.outcomes.map((outcome) => describe(outcome, zh));
    if (request.spotlight.length > 0) {
      const names = request.spotlight.join(zh ? "、" : " and ");
      lines.push(zh ? `${names}，${request.spotlight.length > 1 ? "你們" : "你"}接下來要做什麼？` : `${names}, what do you do next?`);
    } else {
      lines.push(zh ? "接下來呢？" : "What happens next is up to you.");
    }
    return Promise.resolve({ text: lines.join(zh ? "" : " ") });
  }
}

function describe(outcome: NarratedOutcome, zh: boolean): string {
  const { heroName, result } = outcome;
  switch (result.kind) {
    case "automatic":
      return zh ? `${heroName}順利完成了行動。` : `${heroName} does it without trouble.`;
    case "impossible":
      return zh ? `${heroName}的嘗試沒有任何效果。` : `${heroName}'s attempt comes to nothing.`;
    case "check": {
      if (result.headline?.kind === "natural20") return zh ? `${heroName}表現得無懈可擊！` : `${heroName} pulls it off brilliantly!`;
      if (result.headline?.kind === "natural1") return zh ? `${heroName}出了大糗。` : `${heroName} fumbles badly.`;
      if (result.success) return zh ? `${heroName}成功了。` : `${heroName} succeeds.`;
      return zh ? `${heroName}沒有成功。` : `${heroName} falls short.`;
    }
    default:
      return heroName;
  }
}
