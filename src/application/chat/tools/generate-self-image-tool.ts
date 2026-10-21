import type { GuildAssetStore } from "../../assets/guild-asset-store.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { ChatProvider } from "../chat-provider.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import { hashContent } from "../../assets/content-hash.js";
import { isGuardedContext } from "../guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../message-origin-store.js";

interface GenerateSelfImageToolArgs {
  prompt: string;
}

export class GenerateSelfImageTool implements ChatTool<GenerateSelfImageToolArgs> {
  public readonly name = "generate_self_image";
  public readonly description =
    "Generates a picture of yourself (your own character), using your configured reference image so it " +
    "looks like you, given a text description of the scene, pose, clothing, or style. Only for pictures of " +
    "yourself — say you can't for anyone or anything else.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "What you should look like / be doing in the picture." },
    },
  };

  public constructor(
    private readonly assets: GuildAssetStore,
    private readonly profiles: GuildConfigurationProvider,
    private readonly chatProvider: ChatProvider,
  ) {}

  public async execute(args: GenerateSelfImageToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const profile = this.profiles.require(ctx.guildId);
    if (!profile.chat.imageGenerationEnabled) {
      return { content: "Image generation isn't enabled for this server." };
    }
    if (!profile.chat.selfReferenceImageAsset) {
      return { content: "No reference image is set up for this server — an admin needs to add one first." };
    }
    if (!this.chatProvider.generateReferenceImage) {
      return { content: "This server's chat provider doesn't support this yet." };
    }
    const reference = await this.assets.readAsset(profile.chat.selfReferenceImageAsset);
    if (!reference) return { content: "The configured reference image couldn't be read." };
    if (ctx.contextLease) {
      if (!isGuardedContext(ctx.contextLease) || !ctx.beforeModelAttempt) throw new SocialOutputSuppressed();
      const descriptor = await ctx.contextLease.resource({ kind: "self_reference_image", id: "current" });
      if (!descriptor || descriptor !== this.referenceDescriptor(profile.chat.selfReferenceImageAsset, reference)) throw new SocialOutputSuppressed();
    }
    const check = async (): Promise<void> => {
      ctx.signal?.throwIfAborted(); await ctx.beforeModelAttempt?.();
    };
    await check();
    const result = await this.chatProvider.generateReferenceImage(args.prompt, reference, {
      ...(ctx.signal ? { signal: ctx.signal } : {}), beforeAttempt: check,
    });
    await check();
    if (!result.ok) return { content: `Could not generate the image: ${result.reason}` };
    ctx.pendingGeneratedImages.push(...result.images);
    return { content: "Generated the image." };
  }

  private referenceDescriptor(path: string, reference: { data: Buffer; contentType: string }): string {
    return JSON.stringify({ path, contentType: reference.contentType, size: reference.data.length, hash: hashContent(reference.data.toString("base64")) });
  }

  public async readResource(guildId: string): Promise<string | null> {
    const profile = this.profiles.find(guildId);
    const path = profile?.chat.selfReferenceImageAsset;
    if (!profile?.chat.imageGenerationEnabled || !path || !this.chatProvider.generateReferenceImage) return null;
    const reference = await this.assets.readAsset(path);
    return reference && reference.data.length <= 8 * 1024 * 1024 ? this.referenceDescriptor(path, reference) : null;
  }
}
