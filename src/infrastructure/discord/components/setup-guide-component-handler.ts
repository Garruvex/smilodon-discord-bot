import { PermissionFlagsBits } from "discord.js";

import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { setupGuidePrefix, type SetupGuide } from "../settings/setup/setup-guide.js";

// Every /setup guide control and form. Same access as /setup itself —
// Manage Server — so the guide works before anyone holds the bot-admin role.
export class SetupGuideComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = setupGuidePrefix;
  public readonly module = CommandModule.Bootstrap;
  public readonly access = {
    ...publicAccessPolicy,
    requiredMemberPermissions: [PermissionFlagsBits.ManageGuild],
  };

  public constructor(private readonly guide: SetupGuide) {}

  public async execute(context: ComponentContext): Promise<void> {
    await this.guide.handleComponent(context.interaction);
  }

  public async executeModal(context: ModalContext): Promise<void> {
    await this.guide.handleModal(context.interaction);
  }
}
