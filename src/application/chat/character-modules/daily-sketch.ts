import type { CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { ChatResponse } from "../chat-provider.js";
import type { CharacterModuleServices } from "./shared.js";
import { endOfLocalDay } from "../character-calendar.js";
import { personaFingerprint } from "./shared.js";
export class DailySketchModule implements CharacterModule {
  public readonly id = "daily-sketch";
  public constructor(private readonly services: CharacterModuleServices) {}
  public async contributeContext(turn: CharacterTurn): Promise<string | null> {
    const rows = await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "daily-sketch", personaFingerprint(turn.request), turn.request.message);
    return rows.length ? JSON.stringify(rows.map((row) => ({ statement: row.statement, updatedAt: row.updatedAt }))) : null;
  }
  public onConsolidation(_reply: ChatResponse, turn: CharacterTurn): Promise<void> { return this.dailySketch(turn); }
  public async dailySketch(turn: CharacterTurn): Promise<void> {
    if ((await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "daily-sketch", personaFingerprint(turn.request))).length) return;
    const timeZone = this.services.profile(turn).timezone;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(turn.now));
    const canon = await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "canon", personaFingerprint(turn.request));
    const text = await this.services.text(`Write one short fictional "what I'm up to today" sketch for ${day}, solely from personality, canon, and fictional lore. No events involving real members or claims of real-world actions. Data: ${JSON.stringify({ personality: turn.request.personality, lore: turn.request.personaLore, canon: canon.map((memory) => memory.statement) }).replaceAll("<", "\\u003c")}`, turn);
    if (text && this.services.ready(turn, "daily-sketch")) {
      let expiry = turn.now + 60_000;
      expiry = (endOfLocalDay(day, timeZone) ?? expiry) + 1;
      await this.services.memory.write(this.services.profile(turn), turn.request.channelId, "daily-sketch", { ...this.services.base(turn, "daily-sketch", text.slice(0, 200)), kind: "episode", expiresAt: expiry });
    }
  }
}
