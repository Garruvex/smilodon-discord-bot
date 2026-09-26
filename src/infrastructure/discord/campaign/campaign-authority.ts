import type { AccessPolicyService } from "../../../application/access/access-policy-service.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { CommandModule } from "../../../application/commands/command.js";
import { publicAccessPolicy, RoleMatchMode, type CommandAccessPolicy } from "../../../domain/access/access-policy.js";

export type AuthorityInteraction = Parameters<AccessPolicyService["evaluate"]>[2];

// Setting a server up is for bot administrators (plan §3, Server setup).
export const botAdministratorPolicy: CommandAccessPolicy = { ...publicAccessPolicy, roles: { match: RoleMatchMode.Any, requiredGroups: ["botAdministrator"] } };

// Who may create and manage games: bot administrators and holders of the
// server's "DnD Admin" role; a game's own organizer may also manage that game.
// The Discord roles are read from the interaction, so nothing here is stored.
export class CampaignAuthority {
  public constructor(
    private readonly access: AccessPolicyService,
    private readonly unitOfWork: CampaignUnitOfWork,
  ) {}

  public isBotAdministrator(interaction: AuthorityInteraction): boolean {
    return this.access.evaluate(botAdministratorPolicy, CommandModule.Campaign, interaction).allowed;
  }

  // Bot administrators and DnD Admin role holders.
  public async isAdmin(interaction: AuthorityInteraction): Promise<boolean> {
    if (this.isBotAdministrator(interaction)) return true;
    if (!interaction.inCachedGuild()) return false;
    const settings = await this.unitOfWork.transaction((tx) => tx.loadGuildSettings(interaction.guildId));
    const roleId = settings?.adminRoleId ?? null;
    return roleId !== null && interaction.member.roles.cache.has(roleId);
  }

  public async canManage(interaction: AuthorityInteraction, record: CampaignRecord): Promise<boolean> {
    return record.organizerId === interaction.user.id || (await this.isAdmin(interaction));
  }
}
