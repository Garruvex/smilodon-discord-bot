import type { ChatToolContext } from "./chat-tool.js";

// Rechecked on every music-tool call rather than trusted from a single
// resolution made before the LLM call — see ChatToolContext.music. Mirrors
// the role gate music slash commands enforce via musicPlaybackAccessPolicy.
export function musicActorAllowed(music: NonNullable<ChatToolContext["music"]>): boolean {
  return music.actor.member.roles.cache.some((role) =>
    music.musicControllerRoleIds.has(role.id) || music.botAdministratorRoleIds.has(role.id));
}

export const musicPermissionDeniedMessage =
  "The user isn't allowed to control music playback here — tell them they need a music-controller role.";
