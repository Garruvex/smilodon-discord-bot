import type { CharacterSettings } from "../chat/character-settings.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "./guarded-configuration-context.js";
import { immutableSnapshot } from "./immutable-snapshot.js";

const registered = new WeakSet<object>();
export interface EvaluationScope { guildId: string; channelId: string; reviewerId: string }

// Synthetic questions are a separate, explicitly admitted input purpose.
// This authority grants no access to Discord history or learned member facts.
export class GuardedEvaluationContext {
  private closed = false;
  private passes = 0;
  private remainingMs = 60_000;
  private constructor(public readonly scope: Readonly<EvaluationScope>, public readonly persona: GuardedConfigurationContext,
    public readonly question: string, public readonly settings: CharacterSettings,
    private readonly current: () => boolean | Promise<boolean>) {
    for (const key of ["scope", "persona", "question", "settings", "current"]) Object.defineProperty(this, key, { writable: false, configurable: false });
    registered.add(this); Object.seal(this);
  }
  public static async open(scope: EvaluationScope, persona: GuardedConfigurationContext, question: string, settings: CharacterSettings,
    current: () => boolean | Promise<boolean>): Promise<GuardedEvaluationContext> {
    if (!scope.guildId || !scope.channelId || !scope.reviewerId || !question.trim() || question.length > 500 ||
      !isConfigurationContext(persona, "persona") || persona.scope.guildId !== scope.guildId) throw new SocialOutputSuppressed();
    const context = new GuardedEvaluationContext(immutableSnapshot(scope), persona, question, immutableSnapshot(settings), current);
    await context.check(); return context;
  }
  public async check(): Promise<void> {
    if (!registered.has(this) || this.closed || ++this.passes > 256 || this.remainingMs <= 0) throw new SocialOutputSuppressed();
    const started = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async (): Promise<void> => {
        await this.persona.check({ kind: "persona", guildId: this.scope.guildId, ownerUserId: null });
        if (!await this.current()) throw new SocialOutputSuppressed();
      })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SocialOutputSuppressed()), Math.min(this.remainingMs, 8000)); })]);
    } catch (error) { this.closed = true; throw error; }
    finally { if (timer) clearTimeout(timer); this.remainingMs -= Date.now() - started; }
  }
}
export function isEvaluationContext(value: unknown): value is GuardedEvaluationContext {
  return typeof value === "object" && value !== null && registered.has(value);
}
