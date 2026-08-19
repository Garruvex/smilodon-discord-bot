import { Collection, type GuildMember } from "discord.js";
import { describe, expect, it } from "vitest";

import { memberCanControlMusic } from "../../src/infrastructure/discord/commands/music/music-command-support.js";

function fakeMember(roleIds: readonly string[]): GuildMember {
  const cache = new Collection<string, { id: string }>(roleIds.map((id) => [id, { id }]));
  return { roles: { cache } } as unknown as GuildMember;
}

describe("memberCanControlMusic", () => {
  it("allows a member with the musicController role", () => {
    const member = fakeMember(["role-controller"]);
    expect(memberCanControlMusic(member, new Set(["role-controller"]), new Set())).toBe(true);
  });

  it("allows a member with the botAdministrator role", () => {
    const member = fakeMember(["role-admin"]);
    expect(memberCanControlMusic(member, new Set(), new Set(["role-admin"]))).toBe(true);
  });

  it("denies a member with neither role", () => {
    const member = fakeMember(["role-other"]);
    expect(memberCanControlMusic(member, new Set(["role-controller"]), new Set(["role-admin"]))).toBe(false);
  });
});
