import { describe, expect, it, vi } from "vitest";
import { GuardedConfigurationContext, isConfigurationContext } from "../../src/application/context/guarded-configuration-context.js";
import { PersonaBundleCompiler } from "../../src/application/chat/persona-bundle-compiler.js";
import { embedTextsBestEffort } from "../../src/application/chat/embedding-batch.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { ConfigurationModelGateway } from "../../src/application/context/configuration-model-gateway.js";

describe("registered configuration sources", () => {
  it("rejects forged, wrong-purpose and cross-owner contexts", async () => {
    const provider = { compilePersonaBundle: vi.fn(), reply: vi.fn() } as ChatProvider;
    const compiler = new PersonaBundleCompiler(provider, null);
    expect(isConfigurationContext(Object.create(GuardedConfigurationContext.prototype))).toBe(false);
    await expect(compiler.compile({} as GuardedConfigurationContext)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await expect(compiler.compile(await configurationFixture("text", "examples_upload"))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    const preferences = await configurationFixture("brief replies", "user_preferences");
    await expect(preferences.check({ ownerUserId: "someone-else" })).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(provider.compilePersonaBundle).not.toHaveBeenCalled();
  });
  it("copies and freezes authored material and scopes cache identity by owner and purpose", async () => {
    const material = { text: "voice", examples: [{ tags: "hi", user: "hi", character: "hello" }] };
    const one = await GuardedConfigurationContext.open({ kind: "user_preferences", guildId: "g", ownerUserId: "a" }, material, () => true);
    const two = await GuardedConfigurationContext.open({ kind: "user_preferences", guildId: "g", ownerUserId: "b" }, material, () => true);
    material.examples[0]!.user = "changed";
    expect(one.material.examples?.[0]?.user).toBe("hi");
    expect(() => { one.material.examples![0]!.user = "injected"; }).toThrow();
    expect(one.modelOptions("embedding").cacheScope).not.toBe(two.modelOptions("embedding").cacheScope);
  });
  it("discards a compiled result if the upload changes during classification", async () => {
    let current = true; const source = await configurationFixture("## Voice\nHi", "persona_upload", () => current);
    const compilePersonaBundle = vi.fn(() => { current = false; return Promise.resolve([]); });
    const compiler = new PersonaBundleCompiler({ reply: vi.fn(), compilePersonaBundle }, null);
    await expect(compiler.compile(source)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
  it("never falls back to raw individual embeddings after authorization is revoked", async () => {
    let current = true; const source = await configurationFixture("## Voice\nHi", "persona_upload", () => current);
    const embed = vi.fn(); const embedMany = vi.fn(() => { current = false; return Promise.reject(new Error("batch failed")); });
    await expect(embedTextsBestEffort(["voice"], { modelId: "fake", embed, embedMany }, source.modelOptions("embedding"))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(embed).not.toHaveBeenCalled();
  });
  it("rejects content that was appended outside the approved configuration projection", async () => {
    const embed = vi.fn(); const source = await configurationFixture("## Voice\nHi\n## Lore\nA forest");
    await expect(new ConfigurationModelGateway(null, { embed, modelId: "fake" }).embedConfiguration(source, ["HIDDEN_TRANSCRIPT"])).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(embed).not.toHaveBeenCalled();
    expect(() => Object.defineProperty(source, "scope", { value: { kind: "examples_upload", guildId: "other", ownerUserId: null } })).toThrow();
  });
});
