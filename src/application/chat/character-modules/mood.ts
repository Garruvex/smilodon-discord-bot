import type { CharacterModule, CharacterTurn } from "../character-module-registry.js";
import type { CharacterModuleServices } from "./shared.js";
import type { ChannelHistoryMessage } from "../chat-provider.js";
import { serious, personaFingerprint } from "./shared.js";
export class MoodModule implements CharacterModule {
  public readonly id = "mood";
  public constructor(private readonly services: CharacterModuleServices) {}
  public async contributeContext(turn: CharacterTurn): Promise<string | null> {
    if (serious(turn.request.message)) return null;
    const rows = await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "mood", personaFingerprint(turn.request), turn.request.message);
    return rows.length ? JSON.stringify(rows.map((row) => ({ statement: row.statement, updatedAt: row.updatedAt,
      intensity: row.expiresAt ? Math.max(0, (row.expiresAt - turn.now) / Math.max(1, row.expiresAt - row.updatedAt)) : 0,
      rule: "Colors tone only; soften as intensity fades. Never a judgment about a member." }))) : null;
  }
  public onObservation(_event: ChannelHistoryMessage, turn: CharacterTurn): Promise<void> { return this.updateMood(turn); }
  public async updateMood(turn: CharacterTurn): Promise<void> {
    if (!this.services.ready(turn, "mood")) return;
    const baseline = serious(turn.request.message) ? "baseline" : /哈哈|lol|lmao|😂|🤣/iu.test(turn.request.message) ? "amused" : /謝謝|ありがとう|thanks|love/iu.test(turn.request.message) ? "pleased" : /shut up|蠢|笨|うるさい/iu.test(turn.request.message) ? "annoyed" : "baseline";
    if (baseline === "baseline" && !serious(turn.request.message) && (await this.services.memory.read(this.services.profile(turn), this.services.query(turn), "mood", personaFingerprint(turn.request))).length) return;
    await this.services.memory.write(this.services.profile(turn), turn.request.channelId, "mood", { ...this.services.base(turn, "fast-mood", baseline),
      kind: "state", audience: "channel", channelId: turn.request.channelId, isolationChannelId: turn.request.channelId,
      expiresAt: turn.now + turn.settings.modules.mood.intervalMinutes * 60_000 });
  }
}
