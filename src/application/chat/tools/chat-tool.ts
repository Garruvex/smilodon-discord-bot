import type { ChatUser } from "../chat-provider.js";
import type { PlaybackActor } from "../../music/playback-service.js";

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
  // Whether the invoking user is a configured bot owner — mirrors what
  // AccessPolicyService resolves for a live interaction, so a tool's access
  // check (see AccessPolicyEngine) can grant the same owner-bypass a slash
  // command would.
  isOwner: boolean;
  // Null unless the guild has music enabled and the message has a
  // resolvable GuildMember. Non-null does NOT by itself mean the member is
  // allowed to control music — `actor.member` is used to build an
  // AccessSubject and rechecked against the full musicPlaybackAccessPolicy
  // on every call via AccessPolicyEngine (see music-tool-support.ts's
  // evaluateMusicToolAccess), rather than trusting a single check made once
  // before the LLM call — the same engine and policy /pause, /play, etc. run
  // through via AccessPolicyService, so a channel restriction or owner
  // bypass can't diverge between the two paths. Actual voice-channel
  // presence/match is still enforced by PlaybackService itself.
  music: {
    actor: PlaybackActor;
    volumeMaximum: number;
    musicControllerRoleIds: ReadonlySet<string>;
    botAdministratorRoleIds: ReadonlySet<string>;
  } | null;
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
