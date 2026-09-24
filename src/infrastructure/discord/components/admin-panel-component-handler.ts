import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { settingsAccessPolicy } from "../settings/engine/settings-engine.js";
import { adminPanelPrefix, type AdminPanelService } from "../settings/panel/admin-panel-service.js";

// Every admin-panel control and form. Same access as the /settings-*
// commands — both surfaces use settingsAccessPolicy.
export class AdminPanelComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = adminPanelPrefix;
  public readonly module = CommandModule.Common;
  public readonly access = settingsAccessPolicy;

  public constructor(private readonly adminPanelService: AdminPanelService) {}

  public async execute(context: ComponentContext): Promise<void> {
    await this.adminPanelService.handleComponent(context.interaction);
  }

  public async executeModal(context: ModalContext): Promise<void> {
    await this.adminPanelService.handleModal(context.interaction);
  }
}
