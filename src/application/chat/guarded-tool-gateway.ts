import { DiceRollTool } from "./tools/dice-tool.js";
import { EightBallTool } from "./tools/eightball-tool.js";
import { MemoryLookupTool } from "./tools/memory-lookup-tool.js";
import { ReadLinkTool } from "./tools/read-link-tool.js";
import { BirthdayLookupTool } from "./tools/birthday-lookup-tool.js";
import { GenerateSelfImageTool } from "./tools/generate-self-image-tool.js";
import { DiscordServerLookupTool } from "../../infrastructure/discord/discord-server-lookup-tool.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./tools/chat-tool.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";
import { isGuardedContext, type GuardedConversationContext, type GuardedResourceKey, type GuardedContextPort } from "./guarded-conversation-context.js";
import type { ChatUser } from "./chat-provider.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { extendConversationSource } from "../context/conversation-source-registry.js";

// Only reviewed implementations can enter this boundary. A name or a model-
// supplied "filtered" flag cannot turn an unknown tool into a source authority.
export function guardedTools(registry: ChatToolRegistry | null, lease: GuardedConversationContext,
  scope: { enabled: boolean; imageGenerationEnabled?: boolean; guildId: string; channelId: string; userId: string; allowed?: ReadonlySet<string>; disabled?: ReadonlySet<string> },
  check: () => Promise<void>, executed: () => void): ChatTool[] {
  if (!scope.enabled || !registry || !isGuardedContext(lease)) return [];
  const subjects = [...new Set([lease.current.authorId, ...lease.history.map((event) => event.authorId),
    ...lease.replyChain.map((event) => event.authorId), ...lease.burst.map((event) => event.authorId)])];
  const texts = [lease.current, ...lease.history, ...lease.replyChain, ...lease.burst].map((event) => event.content);
  return registry.list().filter((tool) => !scope.disabled?.has(tool.name) && (!scope.allowed || scope.allowed.has(tool.name)) &&
    (tool instanceof DiceRollTool || tool instanceof EightBallTool || tool instanceof MemoryLookupTool || tool instanceof ReadLinkTool ||
      tool instanceof BirthdayLookupTool || tool instanceof DiscordServerLookupTool || tool instanceof GenerateSelfImageTool && scope.imageGenerationEnabled))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, ...(tool.outputKind ? { outputKind: tool.outputKind } : {}),
      execute: async (args: unknown, context: ChatToolContext): Promise<ChatToolResult> => {
        await check(); context.signal?.throwIfAborted();
        if (context.guildId !== scope.guildId || context.channelId !== scope.channelId || context.currentUser.id !== scope.userId) throw new SocialOutputSuppressed();
        if (tool instanceof ReadLinkTool) {
          const raw = typeof args === "object" && args !== null && "url" in args ? args.url : null;
          if (typeof raw !== "string" || !texts.some((text) => text.match(/https?:\/\/[^\s<>]+/gu)?.includes(raw)))
            return { content: "The link must come from supplied authorized conversation context. Ask for the link." };
        }
        const result = await tool.execute(args, { ...context, contextLease: lease, beforeModelAttempt: check, knownSubjectIds: [...new Set([...subjects, ...lease.admittedActorIds])] });
        context.signal?.throwIfAborted(); await check();
        if (tool instanceof ReadLinkTool) lease.recordPublicTool(tool.name, result.content);
        if (tool.outputKind !== "context") executed();
        return { content: result.content.slice(0, 12000) };
      },
    }));
}

export async function resolveGuardedToolResource(registry: ChatToolRegistry | null, key: GuardedResourceKey, context: ChatToolContext): Promise<string | null> {
  context.signal?.throwIfAborted();
  if (key.kind === "self_reference_image") {
    if (key.id !== "current") return null;
    const tool = registry?.list().find((candidate) => candidate instanceof GenerateSelfImageTool);
    return tool instanceof GenerateSelfImageTool ? tool.readResource(context.guildId) : null;
  }
  if (key.kind === "birthday") {
    const tool = registry?.list().find((candidate) => candidate instanceof BirthdayLookupTool);
    return tool instanceof BirthdayLookupTool ? tool.readResource(context.guildId, key.id) : null;
  }
  if (key.id !== "current") return null;
  const tool = registry?.list().find((candidate) => candidate instanceof DiscordServerLookupTool);
  return tool instanceof DiscordServerLookupTool ? tool.readResource(key.kind === "server_events" ? "events" : "server", context) : null;
}

export function guardedToolResourcePort(port: GuardedContextPort, registry: ChatToolRegistry | null,
  context: { currentUser: ChatUser; channelMode: ChatToolContext["channelMode"]; channelIsNsfw: boolean; isOwner: boolean }, turnSignal?: AbortSignal): GuardedContextPort {
  return extendConversationSource(port, { ...(turnSignal ? { turnSignal } : {}), resource: (key, signal): Promise<string | null> => resolveGuardedToolResource(registry, key, {
    ...context, guildId: port.guildId, channelId: port.channelId, music: null, pendingGeneratedImages: [], signal,
  }) });
}
