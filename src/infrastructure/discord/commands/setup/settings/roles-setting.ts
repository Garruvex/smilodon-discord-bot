import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../../application/access/role-group-descriptions.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const rolesSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "roles",
  description: "Adds access roles without removing existing ones.",
  configureOptions: (b) => b
    .addRoleOption((o) => o.setName("administrator").setDescription("Adds a bot administrator role for /settings and inherited music control."))
    .addRoleOption((o) => o.setName("music-controller").setDescription("Adds a role for /play, queue commands, panel controls, and typed song requests."))
    .addRoleOption((o) => o.setName("restricted").setDescription("Adds a role denied from music and chatbot unless bot-owner bypass applies.")),
  handle: (context, _deps, previousProfile, input) => {
    const administrator = context.interaction.options.getRole("administrator");
    const controller = context.interaction.options.getRole("music-controller");
    const restricted = context.interaction.options.getRole("restricted");
    if (administrator) {
      input.botAdministratorRoleIds = [...new Set([...previousProfile.roles.botAdministrator, administrator.id])];
    }
    if (controller) {
      input.musicControllerRoleIds = [...new Set([...previousProfile.roles.musicController, controller.id])];
    }
    if (restricted) {
      input.restrictedRoleIds = [...new Set([...previousProfile.roles.restricted, restricted.id])];
    }
    return Promise.resolve({ ok: true });
  },
  describe: (_previous, updated) => [
    "Access roles updated.",
    `Music controller: ${formatRoleGroupList(updated.roles.musicController)}`,
    roleGroupDescriptions.musicController,
  ].join("\n"),
};
