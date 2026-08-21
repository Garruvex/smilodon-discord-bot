import {
  RoleMatchMode,
  publicAccessPolicy,
  type CommandAccessPolicy,
} from "../../domain/access/access-policy.js";

// Shared by /pause, /play, etc. (music-command-support.ts, an interaction
// away) and their chat-tool bindings (music-tool-support.ts, via
// AccessPolicyEngine) — living in the application layer so both an
// infrastructure command file and an application tool-support module can
// import it without either depending on the other.
export const musicPlaybackAccessPolicy: CommandAccessPolicy = {
  ...publicAccessPolicy,
  roles: {
    match: RoleMatchMode.Any,
    requiredGroups: ["musicController"],
  },
};
