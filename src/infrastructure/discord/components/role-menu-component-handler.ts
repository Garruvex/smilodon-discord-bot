import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler } from "../../../application/components/component-handler.js";
import type { RoleMenuService } from "../../../application/roles/role-menu-service.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";

// Using an already-published role menu is open to any member — the setup
// command (ReactionRolesCommand) is the admin-gated part.
export class RoleMenuComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = "rolemenu";
  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly roleMenuService: RoleMenuService) {}

  public async execute(context: ComponentContext): Promise<void> {
    if (!context.interaction.isStringSelectMenu()) return;
    await this.roleMenuService.handleSelect(context.interaction);
  }
}
