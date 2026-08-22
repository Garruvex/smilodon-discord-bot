import { describe, expect, it, vi } from "vitest";

import { PersonaBundleCompiler } from "../../src/application/chat/persona-bundle-compiler.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import type { PersonaBundle } from "../../src/application/chat/persona-bundle.js";
import type { EmbeddingsClient } from "../../src/infrastructure/chat/openai-embeddings-client.js";

const content = "## Voice\nAlways playful.\n\n## Backstory\nBorn in a forest.\n\n## Rivalry\nDislikes the mod team.";

function providerReturning(samples: readonly (readonly number[])[]): ChatProvider {
  const compilePersonaBundle = vi.fn();
  for (const sample of samples) compilePersonaBundle.mockResolvedValueOnce(sample);
  return { reply: () => Promise.reject(new Error("not used")), compilePersonaBundle };
}

describe("PersonaBundleCompiler.compile — self-consistency", () => {
  it("keeps a section in lore only when a majority of the 3 samples agree", async () => {
    // Index 1 (Backstory) selected in 2/3 samples — majority, stays lore.
    // Index 2 (Rivalry) selected in only 1/3 — not a majority, stays core.
    const provider = providerReturning([[1, 2], [1], []]);
    const compiler = new PersonaBundleCompiler(provider, null);

    const bundle = await compiler.compile(content);

    expect(bundle?.chunks.map((chunk) => chunk.heading)).toEqual(["Backstory"]);
    expect(bundle?.core).toContain("Dislikes the mod team.");
  });

  it("samples the classifier exactly 3 times per compile", async () => {
    const provider = providerReturning([[1], [1], [1]]);
    const compiler = new PersonaBundleCompiler(provider, null);

    await compiler.compile(content);

    expect(provider.compilePersonaBundle).toHaveBeenCalledTimes(3);
  });

  it("returns null (safe fallback) when a sample throws, rather than compiling from partial votes", async () => {
    const compilePersonaBundle = vi.fn()
      .mockResolvedValueOnce([1])
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce([1]);
    const provider: ChatProvider = { reply: () => Promise.reject(new Error("not used")), compilePersonaBundle };
    const compiler = new PersonaBundleCompiler(provider, null);

    await expect(compiler.compile(content)).resolves.toBeNull();
  });
});

describe("PersonaBundleCompiler.compile — embedding cache across reuploads", () => {
  it("reuses a previous bundle's embedding for a chunk whose text is unchanged, without calling embed again", async () => {
    const provider = providerReturning([[1], [1], [1]]);
    const embed = vi.fn(() => Promise.resolve([9, 9]));
    const embeddingsClient: EmbeddingsClient = { embed };
    const compiler = new PersonaBundleCompiler(provider, embeddingsClient);
    const previousBundle: PersonaBundle = {
      sourceHash: "irrelevant",
      core: "irrelevant",
      chunks: [{ heading: "Backstory", text: "Born in a forest.", embedding: [1, 2] }],
      compiledAt: 0,
    };

    const bundle = await compiler.compile(content, previousBundle);

    expect(embed).not.toHaveBeenCalled();
    expect(bundle?.chunks).toEqual([{ heading: "Backstory", text: "Born in a forest.", embedding: [1, 2] }]);
  });

  it("embeds fresh when the chunk text differs from anything in the previous bundle", async () => {
    const provider = providerReturning([[1], [1], [1]]);
    const embed = vi.fn(() => Promise.resolve([9, 9]));
    const embeddingsClient: EmbeddingsClient = { embed };
    const compiler = new PersonaBundleCompiler(provider, embeddingsClient);
    const previousBundle: PersonaBundle = {
      sourceHash: "irrelevant",
      core: "irrelevant",
      chunks: [{ heading: "Backstory", text: "A completely different old backstory.", embedding: [1, 2] }],
      compiledAt: 0,
    };

    const bundle = await compiler.compile(content, previousBundle);

    expect(embed).toHaveBeenCalledWith("Born in a forest.");
    expect(bundle?.chunks).toEqual([{ heading: "Backstory", text: "Born in a forest.", embedding: [9, 9] }]);
  });
});
