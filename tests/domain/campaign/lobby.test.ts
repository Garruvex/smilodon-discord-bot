import { describe, expect, it } from "vitest";

import {
  activeMembers,
  cancel,
  chooseHero,
  freeHeroes,
  join,
  leave,
  openLobby,
  readyToStart,
  remove,
  start,
  type LobbyResult,
  type LobbyState,
} from "../../../src/domain/campaign/lobby/lobby.js";

const heroes = ["c-mira", "c-borin", "c-elspeth"];

function expectOk(result: LobbyResult): LobbyState {
  if (!result.ok) throw new Error(`Refused: ${result.reason}`);
  return result.lobby;
}

function lobby(min = 2, max = 3): LobbyState {
  return expectOk(openLobby(min, max));
}

function seated(): LobbyState {
  let next = lobby();
  next = expectOk(join(next, "u-a"));
  next = expectOk(join(next, "u-b"));
  next = expectOk(chooseHero(next, "u-a", "c-mira", heroes));
  return expectOk(chooseHero(next, "u-b", "c-borin", heroes));
}

describe("opening a lobby", () => {
  it("accepts sane limits and refuses the rest", () => {
    expect(openLobby(1, 6).ok).toBe(true);
    for (const [min, max] of [[0, 3], [3, 2], [1, 7], [1.5, 3]] as const) {
      expect(openLobby(min, max)).toEqual({ ok: false, reason: "invalidLimits" });
    }
  });
});

describe("joining and leaving", () => {
  it("never creates a second seat for the same player", () => {
    const once = expectOk(join(lobby(), "u-a"));
    expect(expectOk(join(once, "u-a"))).toBe(once);
    expect(activeMembers(once)).toHaveLength(1);
  });

  it("refuses the seat after the last one is taken", () => {
    let next = lobby(1, 2);
    next = expectOk(join(next, "u-a"));
    next = expectOk(join(next, "u-b"));
    expect(join(next, "u-c")).toEqual({ ok: false, reason: "full" });
  });

  it("frees a seat on leave, and lets the player return to their earlier hero", () => {
    let next = seated();
    next = expectOk(leave(next, "u-a"));
    expect(activeMembers(next).map((member) => member.userId)).toEqual(["u-b"]);
    expect(freeHeroes(next, heroes)).toEqual(["c-mira", "c-elspeth"]);
    next = expectOk(join(next, "u-a"));
    expect(next.members.find((member) => member.userId === "u-a")).toMatchObject({ status: "ready", heroId: "c-mira" });
  });

  it("does not hand a returning player a hero somebody else took meanwhile", () => {
    let next = expectOk(leave(seated(), "u-a"));
    next = expectOk(join(next, "u-c"));
    next = expectOk(chooseHero(next, "u-c", "c-mira", heroes));
    next = expectOk(leave(next, "u-b"));
    next = expectOk(join(next, "u-a"));
    expect(next.members.find((member) => member.userId === "u-a")).toMatchObject({ status: "creating", heroId: null });
  });

  it("refuses leaving when not a member", () => {
    expect(leave(lobby(), "u-x")).toEqual({ ok: false, reason: "notMember" });
  });

  it("lets only the organizer remove someone", () => {
    const next = seated();
    expect(remove(next, "u-b", "u-a", "u-a")).toEqual({ ok: false, reason: "notOrganizer" });
    expect(activeMembers(expectOk(remove(next, "u-a", "u-a", "u-b")))).toHaveLength(1);
  });
});

describe("choosing a hero", () => {
  it("refuses unknown heroes, heroes another player holds, and non-members", () => {
    const next = seated();
    expect(chooseHero(next, "u-a", "c-nobody", heroes)).toEqual({ ok: false, reason: "unknownHero" });
    expect(chooseHero(next, "u-a", "c-borin", heroes)).toEqual({ ok: false, reason: "heroTaken" });
    expect(chooseHero(next, "u-z", "c-elspeth", heroes)).toEqual({ ok: false, reason: "notMember" });
  });

  it("lets a player switch to a free hero, freeing the old one", () => {
    const next = expectOk(chooseHero(seated(), "u-a", "c-elspeth", heroes));
    expect(freeHeroes(next, heroes)).toEqual(["c-mira"]);
  });
});

describe("starting", () => {
  it("needs the organizer, enough players, and everyone ready", () => {
    expect(start(seated(), "u-b", "u-a")).toEqual({ ok: false, reason: "notOrganizer" });
    expect(start(expectOk(join(lobby(), "u-a")), "u-a", "u-a")).toEqual({ ok: false, reason: "notEnoughPlayers" });
    const unready = expectOk(join(seated(), "u-c"));
    expect(readyToStart(unready)).toBe("notReady");
    expect(start(unready, "u-a", "u-a")).toEqual({ ok: false, reason: "notReady" });
    expect(expectOk(start(seated(), "u-a", "u-a")).status).toBe("started");
  });

  it("ignores withdrawn players, and closes the lobby once started", () => {
    const withdrawn = expectOk(leave(expectOk(join(seated(), "u-c")), "u-c"));
    const started = expectOk(start(withdrawn, "u-a", "u-a"));
    expect(join(started, "u-d")).toEqual({ ok: false, reason: "closed" });
    expect(leave(started, "u-a")).toEqual({ ok: false, reason: "closed" });
    expect(chooseHero(started, "u-a", "c-elspeth", heroes)).toEqual({ ok: false, reason: "closed" });
  });

  it("can be cancelled by the organizer only, once", () => {
    expect(cancel(lobby(), "u-x", "u-a")).toEqual({ ok: false, reason: "notOrganizer" });
    const cancelled = expectOk(cancel(lobby(), "u-a", "u-a"));
    expect(cancelled.status).toBe("cancelled");
    expect(cancel(cancelled, "u-a", "u-a")).toEqual({ ok: false, reason: "closed" });
  });
});
