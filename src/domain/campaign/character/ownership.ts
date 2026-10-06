import type { UserId } from "../core/ids.js";

// Who may act for a hero. The facts it needs from a campaign, without the rest of it.
export interface Presence {
  readonly members: Readonly<Record<UserId, { readonly availability: "present" | "away" }>>;
  // Who may play a hero in a fight while its owner is away: owner -> proxy.
  readonly proxies?: Readonly<Record<UserId, UserId>>;
}

// Whether the actor may act for this hero's owner in a fight: the owner, or
// the player they named while they are away (plan §5, Away mode: proxy play).
export function actsForOwner(state: Presence, actorUserId: UserId, ownerUserId: UserId): boolean {
  if (actorUserId === ownerUserId) return true;
  return state.proxies?.[ownerUserId] === actorUserId && state.members[ownerUserId]?.availability === "away" && state.members[actorUserId]?.availability === "present";
}
