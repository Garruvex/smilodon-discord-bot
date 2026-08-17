import { describe, expect, it } from "vitest";

import { renderProgressBar } from "../../src/application/control-panel/progress-bar-renderer.js";
import type {
  ApplicationProgressBarEmojiReference,
  CustomProgressBarTheme,
  ProgressBarSettings,
} from "../../src/config/guild-configuration.js";

const standard: ProgressBarSettings = { style: "standard", length: 10, customTheme: null };
const applicationEmoji = (
  id: string,
  name: string,
  animated = false,
): ApplicationProgressBarEmojiReference => ({
  id,
  name,
  animated,
  scope: "application" as const,
  applicationId: "123456789012345678",
});
const yohtaTheme: CustomProgressBarTheme = {
  completed: applicationEmoji("111111111111111111", "progressed"),
  remaining: applicationEmoji("222222222222222222", "progress"),
  playing: applicationEmoji("333333333333333333", "yhota_run3", true),
  paused: applicationEmoji("444444444444444444", "yohta_stop"),
  ending: applicationEmoji("555555555555555555", "canned_fish", true),
};

describe("renderProgressBar", () => {
  it("renders portable progress and timestamps", () => {
    expect(renderProgressBar({
      positionMs: 158_000,
      durationMs: 224_000,
      paused: false,
      isStream: false,
      settings: standard,
    })).toBe("▰▰▰▰▰▰▰◆▱▱\n`2:38` / `3:44`");
  });

  it("renders timestamps only when disabled", () => {
    expect(renderProgressBar({
      positionMs: 1_000,
      durationMs: 60_000,
      paused: false,
      isStream: false,
      settings: { ...standard, style: "none" },
    })).toBe("`0:01` / `1:00`");
  });

  it("uses a live indicator for streams", () => {
    expect(renderProgressBar({
      positionMs: 0,
      durationMs: 0,
      paused: false,
      isStream: true,
      settings: standard,
    })).toBe("`LIVE 🔴`");
  });

  it("renders a themed style resolved for the current application", () => {
    const rendered = renderProgressBar({
      positionMs: 30_000,
      durationMs: 60_000,
      paused: true,
      isStream: false,
      settings: { ...standard, style: "yohta" },
      presetTheme: yohtaTheme,
    });
    expect(rendered).toContain("yohta_stop");
    expect(rendered).not.toContain("⏸");
  });
});
