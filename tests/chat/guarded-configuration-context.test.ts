import { describe, expect, it, vi } from "vitest";
import { GuardedConfigurationContext, isConfigurationContext } from "../../src/application/context/guarded-configuration-context.js";
import { PersonaBundleCompiler } from "../../src/application/chat/persona-bundle-compiler.js";
import { embedTextsBestEffort } from "../../src/application/chat/embedding-batch.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { ConfigurationModelGateway } from "../../src/application/context/configuration-model-gateway.js";
import { conversationConfiguration } from "../../src/application/context/conversation-configuration.js";
import { guardedToolResourcePort } from "../../src/application/chat/guarded-tool-gateway.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { guardedFixture, guardedEvent } from "../helpers/guarded-context-fixture.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";

describe("registered configuration sources", () => {
  it("does not reuse another owner's style-derived reply through a public bot quote", async () => {
    const fixture = guardedFixture(); fixture.actors.set("bob", { id: "bob", displayName: "Bob", roleNames: [] });
    const persona = await configurationFixture("Authored persona", "persona", () => true, "guild");
    const store: UserCustomizationStore = { initialize: vi.fn(), save: vi.fn(), clear: vi.fn(), load: (_guild, user) => Promise.resolve(user === "alice" ? "- Tone: concise OWNER_STYLE" : null) };
    const aliceConfiguration = await conversationConfiguration("guild", "alice", persona, store);
    const alice = await GuardedConversationContext.open(guardedToolResourcePort(fixture.port, null, { currentUser: fixture.actors.get("alice")!, channelMode: "shared", channelIsNsfw: false, isOwner: false }, undefined, aliceConfiguration), { count: 0, budget: 4000, burstIds: [] });
    await alice.resource({ kind: "persona_configuration", id: "current" }); await alice.resource({ kind: "user_preferences", id: "alice" });
    fixture.sources.set("answer", { event: guardedEvent("answer", 4500, "STYLE_DERIVED_REPLY", "bot"), origin: "chat", provenance: alice.provenance("STYLE_DERIVED_REPLY") });
    fixture.add(guardedEvent("next", 5000, "what did you say?", "bob", { replyToMessageId: "answer" })); fixture.port.sourceMessageId = "next"; fixture.port.actorId = "bob";
    const bobConfiguration = await conversationConfiguration("guild", "bob", persona, store);
    const bob = await GuardedConversationContext.open(guardedToolResourcePort(fixture.port, null, { currentUser: fixture.actors.get("bob")!, channelMode: "shared", channelIsNsfw: false, isOwner: false }, undefined, bobConfiguration), { count: 40, budget: 4000, burstIds: [] });
    expect(bob.replyChain).toEqual([]); expect(JSON.stringify(bob.history)).not.toContain("STYLE_DERIVED_REPLY");
  });
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
