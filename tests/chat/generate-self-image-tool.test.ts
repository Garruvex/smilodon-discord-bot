import { describe, expect, it, vi } from "vitest";

import { GenerateSelfImageTool } from "../../src/application/chat/tools/generate-self-image-tool.js";
import type { GuildAssetStore } from "../../src/application/assets/guild-asset-store.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { ChatProvider, GeneratedChatImage } from "../../src/application/chat/chat-provider.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";

function fakeContext(): ChatToolContext {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    currentUser: { id: "user-1", displayName: "Tester", roleNames: [] },
    channelIsNsfw: false,
    channelMode: "shared",
    isOwner: false,
    music: null,
    pendingGeneratedImages: [],
  };
}

function fakeProfile(overrides: Partial<{ imageGenerationEnabled: boolean; selfReferenceImageAsset: string | null }> = {}): GuildConfigurationProvider {
  const profile = {
    chat: {
      imageGenerationEnabled: overrides.imageGenerationEnabled ?? true,
      selfReferenceImageAsset: "selfReferenceImageAsset" in overrides
        ? overrides.selfReferenceImageAsset
        : "guild-assets/guild-1/self-reference.png",
    },
  } as unknown as GuildConfiguration;
  return { require: () => profile } as unknown as GuildConfigurationProvider;
}

function fakeAssets(readAsset: GuildAssetStore["readAsset"]): GuildAssetStore {
  return { readAsset } as unknown as GuildAssetStore;
}

const referenceBytes = { data: Buffer.from("fake-png"), contentType: "image/png" };
const generatedImage: GeneratedChatImage = { data: Buffer.from("out"), contentType: "image/png", filename: "self-image-1.png" };

describe("GenerateSelfImageTool", () => {
  it("reports when image generation is disabled for the guild", async () => {
    const tool = new GenerateSelfImageTool(
      fakeAssets(() => Promise.resolve(referenceBytes)),
      fakeProfile({ imageGenerationEnabled: false }),
      { reply: vi.fn() } satisfies ChatProvider,
    );
    const result = await tool.execute({ prompt: "waving" }, fakeContext());
    expect(result.content).toMatch(/isn't enabled/);
  });

  it("reports when no reference image is configured", async () => {
    const tool = new GenerateSelfImageTool(
      fakeAssets(() => Promise.resolve(referenceBytes)),
      fakeProfile({ selfReferenceImageAsset: null }),
      { reply: vi.fn() } satisfies ChatProvider,
    );
    const result = await tool.execute({ prompt: "waving" }, fakeContext());
    expect(result.content).toMatch(/No reference image/);
  });

  it("reports when the chat provider doesn't support reference-image generation", async () => {
    const tool = new GenerateSelfImageTool(
      fakeAssets(() => Promise.resolve(referenceBytes)),
      fakeProfile(),
      { reply: vi.fn() } satisfies ChatProvider,
    );
    const result = await tool.execute({ prompt: "waving" }, fakeContext());
    expect(result.content).toMatch(/doesn't support this/);
  });

  it("reports when the reference image can't be read", async () => {
    const tool = new GenerateSelfImageTool(
      fakeAssets(() => Promise.resolve(null)),
      fakeProfile(),
      { reply: vi.fn(), generateReferenceImage: vi.fn() } satisfies ChatProvider,
    );
    const result = await tool.execute({ prompt: "waving" }, fakeContext());
    expect(result.content).toMatch(/couldn't be read/);
  });

  it("reports the provider's failure reason without throwing", async () => {
    const tool = new GenerateSelfImageTool(
      fakeAssets(() => Promise.resolve(referenceBytes)),
      fakeProfile(),
      {
        reply: vi.fn(),
        generateReferenceImage: vi.fn(() => Promise.resolve({ ok: false, reason: "quota exceeded" })),
      } as unknown as ChatProvider,
    );
    const result = await tool.execute({ prompt: "waving" }, fakeContext());
    expect(result.content).toBe("Could not generate the image: quota exceeded");
  });

  it("on success, pushes the image into ctx.pendingGeneratedImages and returns a short confirmation", async () => {
    const generateReferenceImage = vi.fn(() => Promise.resolve({ ok: true, images: [generatedImage] }));
    const tool = new GenerateSelfImageTool(
      fakeAssets(() => Promise.resolve(referenceBytes)),
      fakeProfile(),
      { reply: vi.fn(), generateReferenceImage } as unknown as ChatProvider,
    );
    const ctx = fakeContext();

    const result = await tool.execute({ prompt: "waving happily" }, ctx);

    expect(generateReferenceImage).toHaveBeenCalledWith("waving happily", referenceBytes);
    expect(ctx.pendingGeneratedImages).toEqual([generatedImage]);
    expect(result.content).toBe("Generated the image.");
  });
});
