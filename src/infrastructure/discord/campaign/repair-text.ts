import type { Texts } from "../../../application/i18n/texts.js";
import type { RepairResult } from "./campaign-setup-service.js";

// What the organizer is told after Repair, for the command and the Manage button.
export function repairText(result: RepairResult, text: Texts): string {
  const t = text.campaign.cmd;
  switch (result.kind) {
    case "ok":
      return result.requeued > 0 ? t.repairedRequeued({ count: result.requeued }) : t.repaired;
    case "missingPermissions":
      return t.repairMissing({ permissions: result.missing.join(", ") });
    case "failed":
      return t.repairFailed({ step: result.step });
    case "archived":
      return text.campaign.manage.finished;
    case "notFound":
      return text.campaign.manage.gone;
    case "notSetup":
      return t.notSetup;
  }
}
