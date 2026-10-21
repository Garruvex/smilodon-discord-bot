import { z } from "zod";
import { CharacterDecisionService, addressedElsewhere, allowsOptionalParticipation, localAddressing } from "./character-decision.js";
import type { ChannelHistoryMessage } from "./chat-provider.js";
import { contributionPolicy } from "./participation-policy.js";

const eventSchema = z.object({ messageId: z.string(), timestampMs: z.number(), authorId: z.string(), authorDisplayName: z.string(), content: z.string(), imageCount: z.number(), replyToMessageId: z.string().nullable().optional(), replyToAuthorId: z.string().nullable().optional() });
export const participationReplaySchema = z.object({ synthetic: z.literal(true), cases: z.array(z.object({
  name: z.string(), trigger: z.enum(["continuation", "spontaneous"]), events: z.array(eventSchema), current: eventSchema,
  aliases: z.array(z.object({ alias: z.string(), subjectIds: z.array(z.string()) })).default([]),
  decision: z.unknown(), expected: z.boolean(),
})).min(1) });
export async function replayParticipation(input: unknown): Promise<readonly { name: string; baseline: boolean; proposed: boolean; expected: boolean; correct: boolean; status: string; calls: number; latencyMs: number }[]> {
  const fixture = participationReplaySchema.parse(input); const outputs = [];
  for (const entry of fixture.cases) {
    let calls = 0; const start = performance.now();
    const service = new CharacterDecisionService(entry.decision === null ? null : { generateCharacterData: (): Promise<unknown> => { calls++; return Promise.resolve(entry.decision); } });
    const current = entry.current as ChannelHistoryMessage; const events = entry.events as ChannelHistoryMessage[];
    const outcome = await service.evaluate({ personality: "Synthetic replay", events, burst: [current], botId: "bot", fixedTarget: null, gapMs: 600_000, speakingShare: 0, thoughts: true, now: current.timestampMs });
    const local = localAddressing(events, current, "bot", 120_000, entry.aliases);
    const elsewhere = addressedElsewhere(current, events, "bot", entry.aliases);
    const proposed = allowsOptionalParticipation(entry.trigger, local, outcome.decision, elsewhere, contributionPolicy(undefined));
    // Record the former admission rule on the same recipient and decision data.
    // This comparison isolates policy; it is not a claim about baseline delivery.
    const old = entry.decision as { confidence?: number; addressing?: string; motivation?: number } | null;
    const baseline = !elsewhere && (entry.trigger !== "continuation" || local === "bot" || local === "continuing") &&
      (!old ? entry.trigger === "continuation" : (old.confidence ?? 0) >= 0.7 && old.addressing !== "unclear" &&
        (entry.trigger !== "continuation" || old.addressing !== "others") && (old.motivation ?? 0) >= (entry.trigger === "continuation" ? 0.5 : 0.75));
    outputs.push({ name: entry.name, baseline, proposed, expected: entry.expected, correct: proposed === entry.expected, status: outcome.status, calls, latencyMs: performance.now() - start });
  }
  return outputs;
}
