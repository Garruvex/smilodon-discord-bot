import { DiceRollTool } from "./tools/dice-tool.js";
import { EightBallTool } from "./tools/eightball-tool.js";
import { MemoryLookupTool } from "./tools/memory-lookup-tool.js";
import { ReadLinkTool } from "./tools/read-link-tool.js";
import { BirthdayLookupTool } from "./tools/birthday-lookup-tool.js";
import { GenerateSelfImageTool } from "./tools/generate-self-image-tool.js";
import { BirthdaySetTool } from "./tools/birthday-set-tool.js";
import { BirthdayMemberSetTool } from "./tools/birthday-member-set-tool.js";
import { BooruSearchTool } from "./tools/booru-search-tool.js";
import { DiscordServerLookupTool } from "../../infrastructure/discord/discord-server-lookup-tool.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./tools/chat-tool.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";
import { isGuardedContext, type GuardedConversationContext, type GuardedResourceKey, type GuardedContextPort } from "./guarded-conversation-context.js";
import type { ChatUser } from "./chat-provider.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { extendConversationSource } from "../context/conversation-source-registry.js";
import { ReviewedMusicTool } from "../../infrastructure/discord/commands/music/reviewed-music-tool.js";
import { immutableSnapshot } from "../context/immutable-snapshot.js";
import type { ConversationConfiguration } from "../context/conversation-configuration.js";
import { isConfigurationContext } from "../context/guarded-configuration-context.js";
import type { PersonaDriftStore } from "./persona-drift-store.js";
import { toolRetrievalQuery } from "../context/retrieval-query.js";

// Only reviewed implementations can enter this boundary. A name or a model-
// supplied "filtered" flag cannot turn an unknown tool into a source authority.
export function guardedTools(registry: ChatToolRegistry | null, lease: GuardedConversationContext,
  scope: { enabled: boolean; imageGenerationEnabled?: boolean; guildId: string; channelId: string; userId: string; allowed?: ReadonlySet<string>; disabled?: ReadonlySet<string> },
  check: () => Promise<void>, executed: () => void,
  authority: Pick<ChatToolContext, "channelIsNsfw" | "channelMode" | "isOwner" | "music"> = { channelIsNsfw: false, channelMode: "shared", isOwner: false, music: null }): ChatTool[] {
  if (!scope.enabled || !registry || !isGuardedContext(lease)) return [];
  const boundAuthority = Object.freeze({ ...authority, music: authority.music ? Object.freeze({ ...authority.music,
    actor: immutableSnapshot(authority.music.actor), musicControllerRoleIds: new Set(authority.music.musicControllerRoleIds),
    botAdministratorRoleIds: new Set(authority.music.botAdministratorRoleIds) }) : null });
  const subjects = [...new Set([lease.current.authorId, ...lease.history.map((event) => event.authorId),
    ...lease.replyChain.map((event) => event.authorId), ...lease.replyOverflow.map((event) => event.authorId), ...lease.burst.map((event) => event.authorId)])];
  const texts = [lease.current, ...lease.history, ...lease.replyChain, ...lease.replyOverflow, ...lease.burst].map((event) => event.content);
  return registry.list().filter((tool) => !scope.disabled?.has(tool.name) && (!scope.allowed || scope.allowed.has(tool.name)) &&
    (tool instanceof DiceRollTool || tool instanceof EightBallTool || tool instanceof MemoryLookupTool || tool instanceof ReadLinkTool ||
      tool instanceof BirthdayLookupTool || tool instanceof BirthdaySetTool || tool instanceof BirthdayMemberSetTool || tool instanceof BooruSearchTool ||
      tool instanceof DiscordServerLookupTool || ReviewedMusicTool.registered(tool) || tool instanceof GenerateSelfImageTool && scope.imageGenerationEnabled))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, ...(tool.outputKind ? { outputKind: tool.outputKind } : {}),
      execute: async (args: unknown, context: ChatToolContext): Promise<ChatToolResult> => {
        await check(); context.signal?.throwIfAborted();
        if (context.guildId !== scope.guildId || context.channelId !== scope.channelId || context.currentUser.id !== scope.userId) throw new SocialOutputSuppressed();
        if (tool instanceof BirthdayMemberSetTool) {
          const id = typeof args === "object" && args !== null && "userId" in args ? args.userId : null;
          const known = new Set([...subjects, ...lease.admittedActorIds]);
          if (typeof id !== "string" || !known.has(id) || !(await lease.participants([id])).length)
            return { content: "The member must be supplied in authorized conversation context; nothing was saved." };
        }
        if (tool instanceof ReadLinkTool) {
          const raw = typeof args === "object" && args !== null && "url" in args ? args.url : null;
          if (typeof raw !== "string" || !texts.some((text) => text.match(/https?:\/\/[^\s<>]+/gu)?.includes(raw)))
            return { content: "The link must come from supplied authorized conversation context. Ask for the link." };
        }
        if (boundAuthority.music && (boundAuthority.music.actor.guildId !== scope.guildId || boundAuthority.music.actor.userId !== scope.userId)) throw new SocialOutputSuppressed();
        const query = tool instanceof MemoryLookupTool && typeof args === "object" && args !== null && "query" in args && typeof args.query === "string"
          ? toolRetrievalQuery(lease, args.query) : undefined;
        const result = await tool.execute(args, { ...context, ...boundAuthority, ...(query ? { retrievalQuery: query } : {}),
          currentUser: lease.current.author ?? { id: lease.current.authorId, displayName: lease.current.authorDisplayName, roleNames: [] },
          contextLease: lease, beforeModelAttempt: check, knownSubjectIds: [...new Set([...subjects, ...lease.admittedActorIds])] });
        context.signal?.throwIfAborted(); await check();
        if (tool instanceof ReadLinkTool || tool instanceof BooruSearchTool) lease.recordPublicTool(tool.name, result.content);
        if (tool.outputKind !== "context") executed();
        return { content: result.content.slice(0, 12000) };
      },
    }));
}

export async function resolveGuardedToolResource(registry: ChatToolRegistry | null, key: GuardedResourceKey, context: ChatToolContext,
  eligible?: (userId: string) => Promise<boolean>): Promise<string | null> {
  context.signal?.throwIfAborted();
  if (key.kind === "music_queue") {
    if (key.id !== "current" || !eligible) return null;
    for (const tool of registry?.list() ?? []) if (ReviewedMusicTool.registered(tool) && tool.outputKind === "context") return tool.readQueue(context, eligible);
    return null;
  }
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
  if (key.kind !== "server_metadata" && key.kind !== "server_events") return null;
  const tool = registry?.list().find((candidate) => candidate instanceof DiscordServerLookupTool);
  return tool instanceof DiscordServerLookupTool ? tool.readResource(key.kind === "server_events" ? "events" : "server", context) : null;
}

export function guardedToolResourcePort(port: GuardedContextPort, registry: ChatToolRegistry | null,
  context: { currentUser: ChatUser; channelMode: ChatToolContext["channelMode"]; channelIsNsfw: boolean; isOwner: boolean }, turnSignal?: AbortSignal,
    configuration?: ConversationConfiguration, drift?: Pick<PersonaDriftStore, "readScopedEpoch"> | null,
    characterConfiguration?: (id: string) => Promise<string | null>): GuardedContextPort {
  const source = { ...port }; const destination = { ...context };
  const persona = configuration?.persona; const preferences = configuration?.preferences;
  return extendConversationSource(port, { ...(turnSignal ? { turnSignal } : {}), resource: async (key, signal): Promise<string | null> => {
    signal.throwIfAborted();
    if (key.kind === "character_configuration") return source.persist === false || !characterConfiguration ? null : characterConfiguration(key.id);
    if (key.kind === "persona_drift") {
      if (!drift || source.shareMemory !== true) return null;
      const epoch = await drift.readScopedEpoch(source.guildId, source.channelId); return epoch === key.id ? epoch : null;
    }
    if (key.kind === "persona_configuration") {
      if (key.id !== "current" || !isConfigurationContext(persona, "persona")) return null;
      await persona.check({ guildId: source.guildId, ownerUserId: null }); return persona.fingerprint;
    }
    if (key.kind === "user_preferences") {
      if (key.id !== destination.currentUser.id || !isConfigurationContext(preferences, "user_preferences") || (await source.actor(key.id, signal))?.id !== key.id) return null;
      await preferences.check({ guildId: source.guildId, ownerUserId: key.id }); return preferences.fingerprint;
    }
    return resolveGuardedToolResource(registry, key, {
      ...destination, guildId: source.guildId, channelId: source.channelId, music: null, pendingGeneratedImages: [], signal,
    }, async (id) => (await source.actor(id, signal))?.id === id);
  } });
}
