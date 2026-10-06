import type { SecurityWindow } from "../../../domain/security/detection-policy.js";
import type { LinkReason } from "../../../domain/security/link-inspection.js";

// Message keys are identifiers; the values they describe ("10s", "ip-address")
// aren't, so these say which key belongs to which value.
export const windowTextKey = {
  "10s": "s10",
  "30s": "s30",
  "1m": "m1",
  "5m": "m5",
} as const satisfies Record<SecurityWindow, string>;

export const linkReasonTextKey = {
  "blocked-domain": "blockedDomain",
  "lookalike": "lookalike",
  "homoglyph": "homoglyph",
  "ip-address": "ipAddress",
  "invite": "invite",
} as const satisfies Record<LinkReason, string>;
