import type { CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatResponse } from "../chat-provider.js";
import type { CharacterModuleServices } from "./shared.js";
import { z } from "zod";
import { callbackState, callbackDateUnresolved, callbackDateDeferred } from "../character-callbacks.js";
import { endOfLocalDay } from "../character-calendar.js";
export class CallbackPlanningModule implements CharacterModule {
  public readonly id = "callbacks";
  public constructor(private readonly services: CharacterModuleServices) {}
  public onConsolidation(_reply: ChatResponse, turn: CharacterTurn): Promise<void> { return this.planCallbacks(turn); }
  public async planCallbacks(turn: CharacterTurn): Promise<void> {
    const memories = (await this.services.repository.findRecallCandidates({ ...this.services.query(turn), subjectIds: [turn.request.currentUser.id] })).memories.filter((memory) => memory.subjectType === "member" && /schedule|event|plan/iu.test(memory.topic) && !callbackState(memory) && !callbackDateUnresolved(memory) && !callbackDateDeferred(memory, turn.now));
    for (const original of memories.slice(0, 3)) {
      let memory = original;
      // Absolute and relative dates need grounded source text and time.
      // Vague dates wait for clarification rather than inventing a schedule.
      let date = memory.statement.match(/\b(\d{4}-\d{2}-\d{2})\b/u)?.[1]; const statementDate = date;
      if (/cancelled|canceled|取消|中止|延期未定/iu.test(memory.statement) || !await this.services.memory.sourceEligible(memory, this.services.profile(turn), this.services.query(turn))) continue;
      const sources = (await this.services.repository.findSources(memory.id)).filter((source) => source.assertedByUserId === memory.subjectId && source.sourceQuote);
      if (!sources.length) continue;
      if ((!date || !sources.some((source) => source.sourceQuote?.includes(date!))) && this.services.hasUtility) {
        const planning = await this.services.callbacks.beginDatePlanning(memory, turn.now);
        if (!planning) continue;
        memory = planning;
        const normalized = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable() }).safeParse(await this.services.generate(
          `Normalize an explicitly dated event to YYYY-MM-DD in ${this.services.profile(turn).timezone}, using only original human quotes. Return null if the fact contradicts its quotes. Resolve explicit relative dates ONLY using sourceTimestampMs of the supporting quote, never createdAt/ingestion time. Vague/undated/cancelled events return null. Never trust a date that appears only in the fact statement. Data: ${JSON.stringify({ statement: memory.statement, sources }).replaceAll("<", "\\u003c")}`,
          { type: "object", additionalProperties: false, required: ["date"], properties: { date: { type: ["string", "null"] } } }));
        if (!normalized.success) continue;
        date = normalized.data.date ?? undefined;
      }
      if (!date || statementDate && date !== statementDate || !this.services.hasUtility && !sources.some((source) => source.sourceQuote?.includes(date))) {
        if (this.services.ready(turn, "callbacks")) await this.services.callbacks.markDateUnresolved(memory);
        continue;
      }
      const end = endOfLocalDay(date, this.services.profile(turn).timezone);
      if (end === null) { await this.services.callbacks.markDateUnresolved(memory); continue; }
      const currentSources = new Set((await this.services.repository.findSources(memory.id)).map((source) => source.id));
      if (sources.some((source) => !currentSources.has(source.id))) continue;
      if (this.services.ready(turn, "callbacks")) await this.services.callbacks.plan(memory, end + turn.settings.modules.callbacks.minDelayMinutes * 60_000, turn.request.channelId);
    }
  }
}
