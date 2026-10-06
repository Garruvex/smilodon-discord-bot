import { describe, expect, it } from "vitest";

import { alex, jamie, kinds, newCampaign, reject, run } from "./campaign-fixtures.js";
import { startedFight, type Fight } from "./combat-fixtures.js";

const dodge = { kind: "combatDodge", combatantId: "c-mira" } as const;

// Mira (Alex) finishes her first turn and Alex steps away (a player cannot leave
// on their own turn); Borin (Jamie) takes his turn; the goblins act; it is
// Mira's turn again.
function aroundToMiraAgain(fight: Fight): Fight {
  fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
  fight.run(alex, { kind: "markAway", userId: "u-alex" });
  fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
  return fight;
}

describe("proxy play in a fight", () => {
  it("lets the player an away owner named take that hero's turn, and nobody else", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "grantProxy", proxyUserId: "u-jamie" });
    // A grant does nothing while the owner is here.
    expect(fight.reject(jamie, { kind: "combatDodge", combatantId: "c-mira" })).toEqual({ code: "notYourCharacter" });
    aroundToMiraAgain(fight);
    // The engine waits for the proxy rather than playing the away hero itself.
    expect(fight.current).toBe("c-mira");
    expect(fight.reject({ kind: "user", userId: "u-stranger" }, dodge)).toEqual({ code: "notYourCharacter" });
    fight.run(jamie, dodge);
    expect(fight.combatant("c-mira").budget.action).toBe(false);
  });

  it("plays the away hero on autopilot when nobody was named, so its turn never waits", () => {
    const fight = aroundToMiraAgain(startedFight());
    // Jamie cannot play her, and the engine does not wait: her turn has already passed.
    expect(fight.reject(jamie, dodge)).toEqual({ code: "notYourCharacter" });
    expect(fight.current).not.toBe("c-mira");
  });

  it("stops when the owner returns or takes the grant back, and reaches nothing outside a fight", () => {
    const returned = startedFight();
    returned.run(alex, { kind: "grantProxy", proxyUserId: "u-jamie" });
    aroundToMiraAgain(returned);
    returned.run(alex, { kind: "markReturned", userId: "u-alex" });
    expect(returned.reject(jamie, dodge)).toEqual({ code: "notYourCharacter" });

    const revoked = startedFight();
    revoked.run(alex, { kind: "grantProxy", proxyUserId: "u-jamie" });
    aroundToMiraAgain(revoked);
    revoked.run(alex, { kind: "revokeProxy" });
    expect(revoked.reject(jamie, dodge)).toEqual({ code: "notYourCharacter" });

    // Outside a fight the proxy can neither act for the hero nor give its items away.
    const calm = run(run(newCampaign(), alex, { kind: "grantProxy", proxyUserId: "u-jamie" }).state, alex, { kind: "markAway", userId: "u-alex" }).state;
    expect(reject(calm, jamie, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null })).toEqual({ code: "notYourCharacter" });
  });

  it("only names a member of the table other than oneself", () => {
    const state = newCampaign();
    expect(reject(state, alex, { kind: "grantProxy", proxyUserId: "u-alex" })).toEqual({ code: "invalidProxy" });
    expect(reject(state, alex, { kind: "grantProxy", proxyUserId: "u-stranger" })).toEqual({ code: "invalidProxy" });
    expect(reject(state, { kind: "user", userId: "u-stranger" }, { kind: "grantProxy", proxyUserId: "u-jamie" })).toEqual({ code: "notMember" });
    const granted = run(state, alex, { kind: "grantProxy", proxyUserId: "u-jamie" });
    expect(kinds(granted.events)).toEqual(["proxyGranted"]);
    // Naming the same player again is harmless; taking it back twice too.
    expect(run(granted.state, alex, { kind: "grantProxy", proxyUserId: "u-jamie" }).events).toEqual([]);
    const revoked = run(granted.state, alex, { kind: "revokeProxy" });
    expect(kinds(revoked.events)).toEqual(["proxyRevoked"]);
    expect(revoked.state.proxies).toEqual({});
    expect(run(revoked.state, alex, { kind: "revokeProxy" }).events).toEqual([]);
  });
});
