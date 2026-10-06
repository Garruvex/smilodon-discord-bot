import { describe, expect, it } from "vitest";

import { decideTrapResponse, type TrapSubject } from "../../../src/domain/security/trap-policy.js";

const everything = { timeout: true, kick: true, ban: true };

function subject(overrides: Partial<TrapSubject> = {}): TrapSubject {
  return {
    isBot: false,
    isWebhook: false,
    isOwner: false,
    roleIds: ["r-member"],
    hasStaffPermission: false,
    botAdministratorRoleIds: ["r-admin"],
    exemptRoleIds: ["r-exempt"],
    can: everything,
    ...overrides,
  };
}

describe("decideTrapResponse", () => {
  it("acts with the configured action on an ordinary member", () => {
    expect(decideTrapResponse(subject(), { action: "timeout" })).toEqual({ kind: "act", action: "timeout" });
    expect(decideTrapResponse(subject(), { action: "ban" })).toEqual({ kind: "act", action: "ban" });
  });

  it.each([
    ["a bot", { isBot: true }, "bot"],
    ["a webhook", { isWebhook: true }, "bot"],
    ["the owner", { isOwner: true }, "owner"],
    ["a bot administrator", { roleIds: ["r-admin"] }, "bot-administrator"],
    ["an exempt role", { roleIds: ["r-member", "r-exempt"] }, "exempt-role"],
    ["staff by permission", { hasStaffPermission: true }, "staff"],
  ] as const)("never touches %s", (_name, overrides, reason) => {
    expect(decideTrapResponse(subject(overrides), { action: "ban" })).toEqual({ kind: "skip", reason });
  });

  it("is blocked, not acting, when the bot can't do that to the member", () => {
    const outranking = subject({ can: { timeout: false, kick: false, ban: false } });
    expect(decideTrapResponse(outranking, { action: "timeout" })).toEqual({ kind: "blocked", action: "timeout" });
  });

  it("checks the capability of the configured action only", () => {
    const cannotBan = subject({ can: { timeout: true, kick: true, ban: false } });
    expect(decideTrapResponse(cannotBan, { action: "kick" })).toEqual({ kind: "act", action: "kick" });
    expect(decideTrapResponse(cannotBan, { action: "ban" })).toEqual({ kind: "blocked", action: "ban" });
  });

  it("checks who is exempt before whether the bot can act", () => {
    const exemptAndOutranking = subject({ roleIds: ["r-exempt"], can: { timeout: false, kick: false, ban: false } });
    expect(decideTrapResponse(exemptAndOutranking, { action: "ban" })).toEqual({ kind: "skip", reason: "exempt-role" });
  });
});
