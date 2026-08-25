import { CommandModule } from "../../commands/command.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { AccessDecision } from "../../../domain/access/access-decision.js";
import type { AccessSubject } from "../../../domain/access/access-rule.js";
import { AccessPolicyEngine } from "../../access/access-policy-engine.js";
import { musicPlaybackAccessPolicy } from "../../music/music-access-policy.js";
import { MusicError } from "../../music/music-errors.js";
import type { ChatToolContext } from "./chat-tool.js";

// Same fixed rule chain /pause, /play, etc. run through via
// AccessPolicyService — see evaluateMusicToolAccess below. Rules are pure
// and stateless, so a module-level instance is fine to share across every
// music tool binding.
const accessPolicyEngine = new AccessPolicyEngine();

export const musicPermissionDeniedMessage =
  "The user isn't allowed to control music playback here — tell them they need a music-controller role.";

// Runs the exact same access-policy rule chain a music slash command runs
// through (AccessPolicyEngine + musicPlaybackAccessPolicy), built from the
// chat-tool's resolved actor instead of a live interaction. Rechecked on
// every music-tool call rather than trusted from a single resolution made
// before the LLM call — see ChatToolContext.music — since a chat turn can
// span multiple tool round-trips and roles/channels can change between them.
export function evaluateMusicToolAccess(
  ctx: ChatToolContext,
  music: NonNullable<ChatToolContext["music"]>,
  profiles: GuildConfigurationProvider,
): AccessDecision {
  const { roleIds, memberPermissions, botPermissions } = music.resolveAccessSubjectFields();
  const subject: AccessSubject = {
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.currentUser.id,
    roleIds,
    memberPermissions,
    botPermissions,
    isOwner: ctx.isOwner,
  };
  return accessPolicyEngine.evaluate(
    subject,
    musicPlaybackAccessPolicy,
    CommandModule.Music,
    profiles.find(ctx.guildId),
  );
}

// Shared by every music tool binding's catch block — same mapping the
// slash-command core actions use, so a MusicError message reads identically
// whether it reached the user via /pause or a pause_music tool call.
export function formatMusicError(error: unknown, fallback: string): string {
  return error instanceof MusicError ? error.message : fallback;
}

export const musicToolTimedOutMessage =
  "That took too long — treat this action as not having happened.";

// Every mutating music tool binding (pause/resume/stop/skip/previous/
// shuffle/volume/play) must call this immediately before its actual
// playback-mutating call, not just at entry — see ChatToolContext.signal's
// comment for why the check has to sit right at the point of mutation.
export function musicToolWasCancelled(ctx: ChatToolContext): boolean {
  return ctx.signal?.aborted ?? false;
}
