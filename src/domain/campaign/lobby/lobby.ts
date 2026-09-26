import type { UserId } from "../core/ids.js";

// The lobby before a campaign starts (plan §3, Lobby and registration). Pure:
// every operation returns the next lobby or the reason it was refused, so the
// same rules hold whatever presents them. Seats are only ever changed through
// these functions, one at a time per campaign.

// creating: joined, no hero yet. ready: hero chosen. withdrawn: left (or was
// removed) before the start; kept so a return can reuse the earlier choice.
export type LobbyMemberStatus = "creating" | "ready" | "withdrawn";

export interface LobbyMember {
  readonly userId: UserId;
  readonly status: LobbyMemberStatus;
  // A preset hero of the adventure.
  readonly heroId: string | null;
}

export interface LobbyState {
  // open: players may join and change heroes. started: the campaign is
  // running. cancelled: the organizer closed the lobby.
  readonly status: "open" | "started" | "cancelled";
  readonly minPlayers: number;
  readonly maxPlayers: number;
  // In the order they first joined; this is the party order.
  readonly members: readonly LobbyMember[];
}

export type LobbyRefusal =
  | "closed"
  | "full"
  | "notMember"
  | "unknownHero"
  | "heroTaken"
  | "notOrganizer"
  | "notEnoughPlayers"
  | "notReady"
  | "invalidLimits";

export type LobbyResult = { readonly ok: true; readonly lobby: LobbyState } | { readonly ok: false; readonly reason: LobbyRefusal };

export const lobbyLimits = { minPlayersFloor: 1, maxPlayersCeiling: 6 } as const;

export function openLobby(minPlayers: number, maxPlayers: number): LobbyResult {
  const valid =
    Number.isInteger(minPlayers) &&
    Number.isInteger(maxPlayers) &&
    minPlayers >= lobbyLimits.minPlayersFloor &&
    maxPlayers <= lobbyLimits.maxPlayersCeiling &&
    minPlayers <= maxPlayers;
  return valid ? { ok: true, lobby: { status: "open", minPlayers, maxPlayers, members: [] } } : { ok: false, reason: "invalidLimits" };
}

export function activeMembers(lobby: LobbyState): readonly LobbyMember[] {
  return lobby.members.filter((member) => member.status !== "withdrawn");
}

// Joining again is harmless: it never creates a second seat.
export function join(lobby: LobbyState, userId: UserId): LobbyResult {
  if (lobby.status !== "open") return refuse("closed");
  const existing = lobby.members.find((member) => member.userId === userId);
  if (existing !== undefined && existing.status !== "withdrawn") return { ok: true, lobby };
  if (activeMembers(lobby).length >= lobby.maxPlayers) return refuse("full");
  if (existing === undefined) return accept(lobby, [...lobby.members, { userId, status: "creating", heroId: null }]);
  // Returning: keep the earlier hero if nobody else took it since.
  const heroId = existing.heroId !== null && !heroTaken(lobby, existing.heroId, userId) ? existing.heroId : null;
  return accept(lobby, replace(lobby, userId, { userId, status: heroId === null ? "creating" : "ready", heroId }));
}

export function leave(lobby: LobbyState, userId: UserId): LobbyResult {
  if (lobby.status !== "open") return refuse("closed");
  const member = lobby.members.find((candidate) => candidate.userId === userId);
  if (member === undefined || member.status === "withdrawn") return refuse("notMember");
  return accept(lobby, replace(lobby, userId, { ...member, status: "withdrawn" }));
}

// The organizer removes an inactive participant; the seat is freed.
export function remove(lobby: LobbyState, actorId: UserId, organizerId: UserId, userId: UserId): LobbyResult {
  if (actorId !== organizerId) return refuse("notOrganizer");
  return leave(lobby, userId);
}

export function chooseHero(lobby: LobbyState, userId: UserId, heroId: string, availableHeroIds: readonly string[]): LobbyResult {
  if (lobby.status !== "open") return refuse("closed");
  const member = lobby.members.find((candidate) => candidate.userId === userId);
  if (member === undefined || member.status === "withdrawn") return refuse("notMember");
  if (!availableHeroIds.includes(heroId)) return refuse("unknownHero");
  if (heroTaken(lobby, heroId, userId)) return refuse("heroTaken");
  return accept(lobby, replace(lobby, userId, { ...member, status: "ready", heroId }));
}

// Preset heroes nobody holds yet, in the adventure's order.
export function freeHeroes(lobby: LobbyState, availableHeroIds: readonly string[]): readonly string[] {
  const held = new Set(activeMembers(lobby).flatMap((member) => (member.heroId === null ? [] : [member.heroId])));
  return availableHeroIds.filter((id) => !held.has(id));
}

export function readyToStart(lobby: LobbyState): LobbyRefusal | null {
  if (lobby.status !== "open") return "closed";
  const active = activeMembers(lobby);
  if (active.length < lobby.minPlayers) return "notEnoughPlayers";
  if (active.some((member) => member.status !== "ready")) return "notReady";
  return null;
}

export function start(lobby: LobbyState, actorId: UserId, organizerId: UserId): LobbyResult {
  if (actorId !== organizerId) return refuse("notOrganizer");
  const problem = readyToStart(lobby);
  return problem === null ? { ok: true, lobby: { ...lobby, status: "started" } } : refuse(problem);
}

export function cancel(lobby: LobbyState, actorId: UserId, organizerId: UserId): LobbyResult {
  if (actorId !== organizerId) return refuse("notOrganizer");
  return lobby.status === "open" ? { ok: true, lobby: { ...lobby, status: "cancelled" } } : refuse("closed");
}

function heroTaken(lobby: LobbyState, heroId: string, exceptUserId: UserId): boolean {
  return activeMembers(lobby).some((member) => member.heroId === heroId && member.userId !== exceptUserId);
}

function replace(lobby: LobbyState, userId: UserId, next: LobbyMember): readonly LobbyMember[] {
  return lobby.members.map((member) => (member.userId === userId ? next : member));
}

function accept(lobby: LobbyState, members: readonly LobbyMember[]): LobbyResult {
  return { ok: true, lobby: { ...lobby, members } };
}

function refuse(reason: LobbyRefusal): LobbyResult {
  return { ok: false, reason };
}
