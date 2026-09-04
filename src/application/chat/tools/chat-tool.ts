import type { ChatUser, GeneratedChatImage } from "../chat-provider.js";
import type { PlaybackActor } from "../../music/playback-service.js";
import type { ChannelMemoryMode } from "../../memory/memory-channel-policy.js";

// A JSON Schema object describing a tool's arguments, sent to the model
// as-is. Kept loose (not the full JSON Schema type) since each tool author
// writes this by hand for OpenAI's strict function-calling mode: every
// property must appear in `required`, with `["type", "null"]` used for
// anything the model may omit.
export type ChatToolParameterSchema = Record<string, unknown>;

export interface ChatToolContext {
  guildId: string;
  channelId: string;
  currentUser: ChatUser;
  // Whether the Discord channel the turn is happening in is age-restricted.
  // Tools that can return adult content (e.g. booru search) must gate on
  // this rather than trusting anything the model passes as an argument.
  channelIsNsfw: boolean;
  // This turn's resolved channel memory isolation mode — lookup_memory
  // (MemoryLookupTool) must honor "disabled" the same way turn-level recall
  // does. See ChatRequest.channelMode for where this is resolved upstream.
  channelMode: ChannelMemoryMode;
  // Whether the invoking user is a configured bot owner — mirrors what
  // AccessPolicyService resolves for a live interaction, so a tool's access
  // check (see AccessPolicyEngine) can grant the same owner-bypass a slash
  // command would.
  isOwner: boolean;
  // Null unless the guild has music enabled and the message has a
  // resolvable GuildMember. Non-null does NOT by itself mean the member is
  // allowed to control music — `resolveAccessSubjectFields()` is used to
  // build an AccessSubject and rechecked against the full
  // musicPlaybackAccessPolicy on every call via AccessPolicyEngine (see
  // music-tool-support.ts's evaluateMusicToolAccess), rather than trusting a
  // single check made once before the LLM call — the same engine and policy
  // /pause, /play, etc. run through via AccessPolicyService, so a channel
  // restriction or owner bypass can't diverge between the two paths. Actual
  // voice-channel presence/match is still enforced by PlaybackService itself.
  music: {
    actor: PlaybackActor;
    // A function rather than precomputed fields so each tool call reads the
    // live Discord member's current roles/permissions (see
    // chat-turn-support.ts's resolveMusicActor) — a turn can span multiple
    // tool round-trips, and roles can change between them. Kept as a plain
    // callback (no discord.js type here) so this application-layer type
    // stays Discord-independent; the Discord-facing behavior that
    // constructs this closes over the live GuildMember.
    resolveAccessSubjectFields: () => {
      roleIds: readonly string[];
      memberPermissions: bigint;
      botPermissions: bigint | null;
    };
    volumeMaximum: number;
    musicControllerRoleIds: ReadonlySet<string>;
    botAdministratorRoleIds: ReadonlySet<string>;
  } | null;
  // Set by the chat provider's per-call timeout race (see executeToolCall in
  // openai-responses-chat-provider.ts / gemini-chat-provider.ts) and aborted
  // the instant that timeout fires. A losing tool.execute() call keeps
  // running after the model has already been told it timed out — there's no
  // way to truly cancel an in-flight async call from the outside — so any
  // tool about to perform a real side effect (music playback control, chief
  // among them) should check `signal?.aborted` immediately before making
  // that mutating call and bail out instead, rather than applying an action
  // the model (and the user watching its reply) has already moved on from.
  signal?: AbortSignal;
  // A ChatToolResult is text-only and can't carry an attachable image — a
  // tool that generates one (currently just GenerateSelfImageTool) pushes it
  // here instead. The same array instance is passed to every tool call
  // within one turn (see reply() in gemini-chat-provider.ts /
  // openai-responses-chat-provider.ts), and is concatenated into the turn's
  // final ChatResponse.generatedImages once every round trip finishes.
  pendingGeneratedImages: GeneratedChatImage[];
}

export interface ChatToolResult {
  // Stringified result fed back to the model as a function_call_output. Keep
  // this small and model-readable (short JSON or plain text), not a raw
  // dump of an internal record.
  content: string;
}

export interface ChatTool<TArgs = unknown> {
  // Sent to the model as the function's name — must match Responses API
  // function-name constraints (letters, digits, underscores).
  name: string;
  description: string;
  parameters: ChatToolParameterSchema;
  // Never throws: a failed lookup or upstream error should be reported back
  // to the model as a ChatToolResult so it can recover in its final reply,
  // rather than aborting the whole turn.
  execute(args: TArgs, ctx: ChatToolContext): Promise<ChatToolResult>;
}
