import { hashContent } from "../assets/content-hash.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { immutableSnapshot } from "./immutable-snapshot.js";
import type { EmbeddingCallOptions } from "../chat/embeddings-client.js";
import type { ExampleExchange } from "../chat/example-exchange.js";
import type { PersonaLoreChunk } from "../chat/persona-source.js";

export type ConfigurationKind = "persona" | "persona_upload" | "examples_upload" | "user_preferences";
export interface ConfigurationScope { kind: ConfigurationKind; guildId: string; ownerUserId: string | null }
export interface ConfigurationMaterial {
  text: string;
  loreChunks?: readonly PersonaLoreChunk[];
  examples?: readonly ExampleExchange[];
}
const registered = new WeakSet<object>();
export const configurationMaterialHash = (material: ConfigurationMaterial): string => hashContent(JSON.stringify(material, (key, value: unknown) => key === "embedding" ? undefined : value));
// Issuance imports are restricted to approved configuration source adapters.
// This authority never certifies learned facts or real participant transcripts.
export class GuardedConfigurationContext {
  private closed = false;
  private passes = 0;
  private remainingMs = 60_000;
  private readonly source: ConfigurationMaterial;
  private readonly identity: ConfigurationScope;
  public readonly fingerprint: string;
  private constructor(scope: ConfigurationScope, material: ConfigurationMaterial, private readonly current: () => Promise<boolean> | boolean) {
    this.identity = immutableSnapshot(scope); this.source = immutableSnapshot(material);
    this.fingerprint = hashContent(JSON.stringify({ scope, material: configurationMaterialHash(material) })); registered.add(this);
    Object.defineProperty(this, "fingerprint", { writable: false, configurable: false });
    Object.defineProperty(this, "identity", { writable: false, configurable: false });
    Object.defineProperty(this, "source", { writable: false, configurable: false });
    Object.seal(this);
  }
  public get scope(): ConfigurationScope { return this.identity; }
  public get material(): ConfigurationMaterial { return this.source; }
  public static async open(scope: ConfigurationScope, material: ConfigurationMaterial, current: () => Promise<boolean> | boolean): Promise<GuardedConfigurationContext> {
    if (!["persona", "persona_upload", "examples_upload", "user_preferences"].includes(scope.kind) || !scope.guildId ||
        scope.kind === "user_preferences" && !scope.ownerUserId || material.text.length > 200_000 ||
        JSON.stringify(material, (key, value: unknown) => key === "embedding" ? undefined : value).length > 400_000) throw new SocialOutputSuppressed();
    const context = new GuardedConfigurationContext(scope, material, current); await context.check(); return context;
  }
  public async check(scope?: Partial<ConfigurationScope>): Promise<void> {
    if (!registered.has(this) || this.closed || ++this.passes > 256 || this.remainingMs <= 0 ||
        scope && Object.entries(scope).some(([key, value]) => this.identity[key as keyof ConfigurationScope] !== value)) throw new SocialOutputSuppressed();
    let timer: ReturnType<typeof setTimeout> | undefined; const started = Date.now();
    try {
      const valid = await Promise.race([Promise.resolve().then(this.current), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.min(8000, this.remainingMs));
      })]);
      if (!valid) throw new SocialOutputSuppressed();
    } catch (error) { this.closed = true; throw error; }
    finally { if (timer) clearTimeout(timer); this.remainingMs -= Date.now() - started; }
  }
  public modelOptions(purpose: string): EmbeddingCallOptions {
    if (!registered.has(this) || this.closed) throw new SocialOutputSuppressed();
    return { beforeAttempt: () => this.check(), cacheScope: `configuration:${purpose}:${this.fingerprint}` };
  }
}
export function isConfigurationContext(value: unknown, kind?: ConfigurationKind): value is GuardedConfigurationContext {
  return !!value && typeof value === "object" && registered.has(value) && (!kind || (value as GuardedConfigurationContext).scope.kind === kind);
}
