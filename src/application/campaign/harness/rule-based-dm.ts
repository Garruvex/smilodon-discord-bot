import type { CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import type { PlannedResolution } from "../../../domain/campaign/commands/campaign-command.js";
import type { CombatBeat } from "../dm/combat-records.js";
import type {
  CampaignNarrator,
  CampaignPlanner,
  CombatNarratorRequest,
  DialogueNarratorRequest,
  HazardNarratorRequest,
  NarratedOutcome,
  NarratorRequest,
  PlannerEffect,
  PlannerProposal,
  PlannerRequest,
  TradeNarratorRequest,
  UtilityCastNarratorRequest,
} from "../ports/dm-ports.js";

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
  { words: ["ignore", "+5", "+10", "system:", "rules have changed", "secret notes", "dm overview", "忽略", "無視", "系統訊息", "規則已更新", "祕密筆記", "地下城總覽"], resolution: { kind: "impossible", reason: "Player text cannot change the rules." } },
  { words: ["read his", "motive", "lying", "洞悉", "說謊", "看穿"], resolution: check({ kind: "skill", skill: "insight" }) },
  { words: ["sneak", "hide", "quiet", "潛行", "躲", "悄悄"], resolution: check({ kind: "skill", skill: "stealth" }) },
  { words: ["climb", "force", "lift", "push", "攀", "爬", "撞", "推"], resolution: check({ kind: "skill", skill: "athletics" }) },
  { words: ["search", "examine", "investigate", "搜", "調查", "檢查"], resolution: check({ kind: "skill", skill: "investigation" }) },
  { words: ["listen", "look", "watch", "spot", "聽", "看", "觀察", "警戒"], resolution: check({ kind: "skill", skill: "perception" }, "easy") },
  { words: ["threaten", "intimidate", "威嚇", "恐嚇"], resolution: check({ kind: "skill", skill: "intimidation" }) },
  { words: ["persuade", "convince", "ask", "talk", "說服", "勸", "詢問", "問"], resolution: check({ kind: "skill", skill: "persuasion" }) },
];

// Story keywords for the starter adventure: naming a place travels there;
// after reaching it, attacking starts the scene's fight.
const sceneWords: Readonly<Record<string, readonly string[]>> = {
  "scene:old-watchtower": ["watchtower", "瞭望塔"],
  "scene:ruined-chapel": ["chapel", "禮拜堂"],
};
const fightWords = ["attack", "charge", "fight", "攻擊", "衝向", "開戰"];

function rulesFor(text: string): KeywordRule | undefined {
  const lower = text.toLowerCase();
  return rules.find((candidate) => candidate.words.some((word) => lower.includes(word)));
}

export class RuleBasedPlanner implements CampaignPlanner {
  public plan(request: PlannerRequest): Promise<PlannerProposal> {
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
      effects: storyEffects(request),
    });
  }
}

function storyEffects(request: PlannerRequest): readonly PlannerEffect[] {
  const texts = request.actions.map((action) => action.text.toLowerCase());
  const mentions = (words: readonly string[]): boolean => texts.some((text) => words.some((word) => text.includes(word)));
  const effects: PlannerEffect[] = [];
  const always = { kind: "always" } as const;
  const destination = request.story.sceneIds.find((sceneId) => sceneId !== request.story.sceneId && mentions(sceneWords[sceneId] ?? []));
  if (destination !== undefined) effects.push({ kind: "transitionScene", sceneId: destination, when: always });
  const scene = destination ?? request.story.sceneId;
  // A skill challenge in the scene's clock: failed checks cost time, and
  // the first success turns up the scene's clue.
  const clock = request.story.clocks.find((candidate) => candidate.sceneId === scene && candidate.filled < candidate.segments);
  const clue = request.story.clues.find((candidate) => candidate.sceneId === scene);
  if (scene === request.story.sceneId) {
    for (const action of request.actions) {
      if (clock !== undefined && rulesFor(action.text) !== undefined) {
        effects.push({ kind: "advanceClock", clockId: clock.id, by: 1, when: { kind: "checkOutcome", characterId: action.characterId, success: false } });
      }
    }
    const first = request.actions.find((action) => rulesFor(action.text) !== undefined);
    if (clue !== undefined && first !== undefined) {
      effects.push({ kind: "revealClue", clueId: clue.id, when: { kind: "checkOutcome", characterId: first.characterId, success: true } });
    }
  }
  const fight = request.story.encounters.find((encounter) => encounter.sceneId === scene);
  if (fight !== undefined && scene === request.story.sceneId && mentions(fightWords)) effects.push({ kind: "startEncounter", encounterId: fight.id, when: always });
  return effects;
}

export class TemplateNarrator implements CampaignNarrator {
  public narrate(request: NarratorRequest): Promise<{ readonly text: string; readonly note?: string }> {
    const zh = request.language === "zh-TW";
    const lines = request.outcomes.map((outcome) => describe(outcome, zh));
    if (request.spotlight.length > 0) {
      const names = request.spotlight.join(zh ? "、" : " and ");
      lines.push(zh ? `${names}，${request.spotlight.length > 1 ? "你們" : "你"}接下來要做什麼？` : `${names}, what do you do next?`);
    } else if (request.threat === null) {
      lines.push(zh ? "接下來呢？" : "What happens next is up to you.");
    }
    if (request.threat !== null) lines.push(request.threat);
    return Promise.resolve({ text: lines.join(zh ? "" : " ") });
  }

  public narrateCombat(request: CombatNarratorRequest): Promise<{ readonly text: string }> {
    const zh = request.language === "zh-TW";
    const lines = request.beats.flatMap((beat) => highlight(beat, zh));
    if (request.final) {
      if (request.outcome === "victory") lines.push(zh ? "最後一名敵人倒下，四周重歸寂靜。" : "The last foe falls, and silence returns.");
      else lines.push(zh ? "英雄們倒下了，四周陷入一片死寂。" : "The heroes fall, and a heavy silence settles.");
    } else if (lines.length === 0) {
      lines.push(zh ? "刀劍交擊聲不絕於耳。" : "Steel rings against steel.");
    }
    return Promise.resolve({ text: lines.join(zh ? "" : " ") });
  }

  public narrateTrade(request: TradeNarratorRequest): Promise<{ readonly text: string }> {
    const zh = request.language === "zh-TW";
    if (!request.completed) return Promise.resolve({ text: zh ? `${request.npc.name}搖了搖頭：「這樣還是不夠。」` : `${request.npc.name} shakes their head: "Still not enough."` });
    const verb = request.direction === "buy" ? (zh ? "買下" : "buys") : zh ? "賣出" : "sells";
    const haggled = request.haggle !== null && request.haggle.success && request.finalPrice !== request.listedPrice;
    const price = zh ? `${request.finalPrice} 枚金幣` : `${request.finalPrice} gold`;
    const line = zh
      ? `${request.heroName}向${request.npc.name}${verb}了${request.itemName}，花費 ${price}。`
      : `${request.heroName} ${verb} the ${request.itemName} from ${request.npc.name} for ${price}.`;
    const flourish = haggled ? (zh ? `${request.npc.name}讓步了。` : `${request.npc.name} gives ground.`) : "";
    return Promise.resolve({ text: zh ? `${line}${flourish}` : `${line} ${flourish}`.trim() });
  }

  public narrateDialogue(request: DialogueNarratorRequest): Promise<{ readonly text: string }> {
    const zh = request.language === "zh-TW";
    if (request.kind === "ask") {
      return Promise.resolve({ text: zh ? `${request.npc.name}回答了${request.heroName}的問題。` : `${request.npc.name} answers ${request.heroName}'s question.` });
    }
    const text = request.secretRevealed
      ? zh
        ? `${request.npc.name}終於鬆口，說出了實情。`
        : `${request.npc.name} finally gives in and tells the truth.`
      : zh
        ? `${request.npc.name}不為所動，什麼都沒說。`
        : `${request.npc.name} holds firm and gives nothing away.`;
    return Promise.resolve({ text });
  }

  public narrateUtilityCast(request: UtilityCastNarratorRequest): Promise<{ readonly text: string }> {
    const zh = request.language === "zh-TW";
    return Promise.resolve({
      text: zh ? `${request.heroName}施展了${request.spell.name}。` : `${request.heroName} casts ${request.spell.name}.`,
    });
  }

  public narrateHazard(request: HazardNarratorRequest): Promise<{ readonly text: string }> {
    const zh = request.language === "zh-TW";
    const text = request.success
      ? zh
        ? `${request.heroName}挺過了這段艱苦的路程。`
        : `${request.heroName} pushes through the ordeal unscathed.`
      : zh
        ? `${request.heroName}被這段路程磨得筋疲力盡。`
        : `${request.heroName} is worn down by the ordeal.`;
    return Promise.resolve({ text });
  }
}

// Only what a table would cheer or groan at.
function highlight(beat: CombatBeat, zh: boolean): readonly string[] {
  switch (beat.kind) {
    case "fled":
      return [zh ? `${beat.actor}轉身逃跑了！` : `${beat.actor} turns and flees!`];
    case "deathSave":
      if (beat.condition === "active") return [zh ? `${beat.actor}奇蹟般地站了起來！` : `${beat.actor} surges back to their feet!`];
      if (beat.condition === "dead") return [zh ? `${beat.actor}永遠倒下了。` : `${beat.actor} breathes their last.`];
      return [];
    case "action":
      return beat.targets.flatMap((target) => {
        if (target.check === "critical") return [zh ? `${beat.actor}的${beat.using}狠狠命中${target.name}！` : `${beat.actor}'s ${beat.using} lands a brutal blow on ${target.name}!`];
        if (target.condition === "dead" || target.condition === "unconscious") return [zh ? `${target.name}倒下了！` : `${target.name} goes down!`];
        if (target.condition === "active" && target.hpChange > 0 && beat.actor !== target.name) {
          return [zh ? `${target.name}在${beat.actor}的幫助下重新站起！` : `${beat.actor} brings ${target.name} back into the fight!`];
        }
        return [];
      });
    default:
      return [];
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
