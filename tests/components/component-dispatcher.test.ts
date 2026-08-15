import type { MessageComponentInteraction } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AccessPolicyService } from "../../src/application/access/access-policy-service.js";
import { CommandModule } from "../../src/application/commands/command.js";
import { ComponentDispatcher } from "../../src/application/components/component-dispatcher.js";
import type { ComponentHandler } from "../../src/application/components/component-handler.js";
import { ComponentRegistry } from "../../src/application/components/component-registry.js";
import { AccessDenialReason } from "../../src/domain/access/access-decision.js";
import { publicAccessPolicy } from "../../src/domain/access/access-policy.js";

function interaction(): MessageComponentInteraction {
  return {
    customId: "test:action",
    guildId: "123456789012345678",
    channelId: "234567890123456789",
    user: { id: "345678901234567890" },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessageComponentInteraction;
}

describe("ComponentDispatcher", () => {
  it("executes an allowed component handler", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const handler: ComponentHandler = {
      customIdPrefix: "test",
      module: CommandModule.Common,
      access: publicAccessPolicy,
      execute,
    };
    const registry = new ComponentRegistry();
    registry.register(handler);
    const evaluate = vi.fn().mockReturnValue({ allowed: true });
    const access = { evaluate } as unknown as AccessPolicyService;
    const dispatcher = new ComponentDispatcher(registry, access, {} as Logger);
    const componentInteraction = interaction();

    await dispatcher.dispatch(componentInteraction);

    expect(evaluate).toHaveBeenCalledWith(
      publicAccessPolicy,
      CommandModule.Common,
      componentInteraction,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("replies ephemerally without executing a denied component handler", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const handler: ComponentHandler = {
      customIdPrefix: "test",
      module: CommandModule.Common,
      access: publicAccessPolicy,
      execute,
    };
    const registry = new ComponentRegistry();
    registry.register(handler);
    const access = {
      evaluate: vi.fn().mockReturnValue({
        allowed: false,
        reason: AccessDenialReason.ChannelNotAllowed,
      }),
    } as unknown as AccessPolicyService;
    const logger = { warn: vi.fn() } as unknown as Logger;
    const dispatcher = new ComponentDispatcher(registry, access, logger);
    const reply = vi.fn().mockResolvedValue(undefined);
    const componentInteraction = {
      ...interaction(),
      reply,
    } as unknown as MessageComponentInteraction;

    await dispatcher.dispatch(componentInteraction);

    expect(execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "You are not allowed to use this control here." }),
    );
  });
});
