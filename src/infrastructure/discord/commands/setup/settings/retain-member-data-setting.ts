import type { MutationSettingDefinition } from "./setting-definition.js";

export const retainMemberDataSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "member-data",
  description: "Controls what happens to a member's chat memories, birthday, and customization when they leave.",
  configureOptions: (b) => b.addBooleanOption((o) =>
    o.setName("retain").setDescription("true: keep their data if they return. false: delete it when they leave.").setRequired(true)),
  handle: (context, _deps, _previousProfile, input) => {
    input.retainMemberDataOnLeave = context.interaction.options.getBoolean("retain", true);
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [{ label: "Retain member data on leave", read: (p) => p.features.retainMemberDataOnLeave }],
};
