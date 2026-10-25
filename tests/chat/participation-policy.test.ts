import { describe, expect, it } from "vitest";
import { contributionPolicy, defaultParticipation, isLowSubstancePing, resolveDecisionContract, resolveParticipation, resolveSimpleThreshold, type ParticipationSettings } from "../../src/application/chat/participation-policy.js";
import { guildConfigurationFileSchema } from "../../src/config/guild-configuration-schema.js";
import { freshDocument } from "../helpers/settings-fixtures.js";

describe("participation policy", () => {
  it("scopes contextual flow and shadow mode to one explicit channel", () => {
    const settings = { ...defaultParticipation, flowVersion: "legacy" as const, shadowMode: false,
      channelOverrides: { pilot: { flowVersion: "contextual_v1" as const, shadowMode: true } } };
    expect(resolveParticipation(settings, "pilot")).toMatchObject({ flowVersion: "contextual_v1", shadowMode: true });
    expect(resolveParticipation(settings, "other")).toMatchObject({ flowVersion: "legacy", shadowMode: false });
  });
  it("keeps new unsolicited triggers off on schema upgrade", () => {
    const document = freshDocument();
    const { participation: _unused, ...oldChat } = document.chat;
    const upgraded = guildConfigurationFileSchema.parse({ ...document, chat: oldChat });
    expect(upgraded.chat.participation).toMatchObject({ continuationEnabled: false, spontaneousEnabled: false,
      spontaneousChannelIds: [], shadowMode: false, barePingMode: "acknowledge" });
  });
  it("inherits or overrides independently but cannot bypass the spontaneous allow-list", () => {
    const settings = { ...defaultParticipation, continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: ["allowed"],
      channelOverrides: { allowed: { continuationEnabled: false, activity: "quiet" as const }, denied: { spontaneousEnabled: true } } };
    expect(resolveParticipation(settings, "allowed")).toMatchObject({ continuationEnabled: false, spontaneousEnabled: true,
      limits: { textPerWindow: 1 } });
    expect(resolveParticipation(settings, "denied").spontaneousEnabled).toBe(false);
    expect(resolveParticipation(undefined, "allowed").continuationEnabled).toBe(false);
  });
  it("treats only low-content pings as optional, never questions, replies, or image requests", () => {
    expect(isLowSubstancePing("", false, false)).toBe(true);
    expect(isLowSubstancePing("hey", false, false)).toBe(true);
    expect(isLowSubstancePing("what about tomorrow?", false, false)).toBe(false);
    expect(isLowSubstancePing("?", true, false)).toBe(false);
    expect(isLowSubstancePing("", false, true)).toBe(false);
  });
});

describe("simple contract resolution", () => {
  const settings = (extra: Partial<ParticipationSettings> = {}): ParticipationSettings => ({ ...defaultParticipation, ...extra });
  it("resolves channel, then guild, then instance", () => {
    expect(resolveDecisionContract(undefined, "c1", "legacy")).toEqual({ contract: "legacy", source: "instance" });
    expect(resolveDecisionContract(settings({ decisionContract: "simple" }), "c1", "legacy")).toEqual({ contract: "simple", source: "guild" });
    expect(resolveDecisionContract(settings({ decisionContract: "simple", channelOverrides: { c1: { decisionContract: "legacy" } } }), "c1", "simple")).toEqual({ contract: "legacy", source: "channel" });
    expect(resolveDecisionContract(settings({ decisionContract: "simple", channelOverrides: { c1: { decisionContract: "legacy" } } }), "c2", "legacy")).toEqual({ contract: "simple", source: "guild" });
  });
  it("resolves each kind's simple threshold independently and keeps legacy thresholds out of it", () => {
    const value = settings({ spontaneousThreshold: 0.9, continuationThreshold: 0.8, simpleActionThresholds: { followup: 0.6 }, channelOverrides: { c1: { simpleActionThresholds: { joining: 0.4, followup: 0 } } } });
    expect(resolveSimpleThreshold(value, "c1", "followup")).toEqual({ value: 0, source: "channel" });
    expect(resolveSimpleThreshold(value, "c1", "joining")).toEqual({ value: 0.4, source: "channel" });
    expect(resolveSimpleThreshold(value, "c2", "followup")).toEqual({ value: 0.6, source: "guild" });
    expect(resolveSimpleThreshold(value, "c2", "joining")).toEqual({ value: 0, source: "default" });
    expect(resolveSimpleThreshold(undefined, "c1", "joining")).toEqual({ value: 0, source: "default" });
    expect(contributionPolicy(value)).toMatchObject({ spontaneousThreshold: 0.9, continuationThreshold: 0.8 });
  });
});
