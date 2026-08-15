import { describe, expect, it } from "vitest";

import { RoleMatchMode } from "../../src/domain/access/access-policy.js";
import { PlayCommand } from "../../src/infrastructure/discord/commands/music/play-command.js";

describe("PlayCommand", () => {
  it("requires the music-controller role group", () => {
    const command = new PlayCommand({} as never);

    expect(command.access.roles).toEqual({
      match: RoleMatchMode.Any,
      requiredGroups: ["musicController"],
    });
  });
});
