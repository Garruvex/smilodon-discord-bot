import { describe, expect, it } from "vitest";

import { en } from "../../src/application/i18n/messages/en.js";
import { buildTexts, texts, type Texts } from "../../src/application/i18n/texts.js";
import {
  MusicAutoQueueRerollEmptyError,
  MusicAutoQueueRerollLimitError,
  MusicAutoQueueVoteClosedError,
  MusicAutoQueueVoteUnavailableError,
  MusicChannelAccessError,
  MusicError,
  MusicPlayerNotFoundError,
  MusicRateLimitError,
  MusicSearchEmptyError,
  MusicVoiceChannelMismatchError,
  MusicVoiceChannelRequiredError,
  musicErrorText,
} from "../../src/application/music/music-errors.js";

describe("musicErrorText", () => {
  it("renders each music failure from the catalog", () => {
    const errors = texts.en.music.error;
    expect(musicErrorText(new MusicPlayerNotFoundError(), texts.en)).toBe(errors.playerNotFound);
    expect(musicErrorText(new MusicSearchEmptyError(), texts.en)).toBe(errors.searchEmpty);
    expect(musicErrorText(new MusicVoiceChannelRequiredError(), texts.en)).toBe(errors.voiceRequired);
    expect(musicErrorText(new MusicVoiceChannelMismatchError(), texts.en)).toBe(errors.voiceMismatch);
    expect(musicErrorText(new MusicChannelAccessError(), texts.en)).toBe(errors.channelAccess);
  });

  it("keeps the English catalog text identical to each error's own message", () => {
    // `message` is what logs and the chat model see; the two must not drift.
    for (const error of [
      new MusicPlayerNotFoundError(),
      new MusicSearchEmptyError(),
      new MusicVoiceChannelRequiredError(),
      new MusicVoiceChannelMismatchError(),
      new MusicChannelAccessError(),
      new MusicRateLimitError(1),
      new MusicRateLimitError(5),
      new MusicAutoQueueVoteUnavailableError(),
      new MusicAutoQueueRerollEmptyError(),
      new MusicAutoQueueRerollEmptyError("Jay Chou"),
      new MusicAutoQueueVoteClosedError(),
      new MusicAutoQueueRerollLimitError(3),
    ]) {
      expect(musicErrorText(error, texts.en), error.name).toBe(error.message);
    }
  });

  it("renders the autoqueue vote failures in the server language, with their values", () => {
    const errors = texts.ja.music.error;
    expect(musicErrorText(new MusicAutoQueueVoteUnavailableError(), texts.ja)).toBe(errors.voteUnavailable);
    expect(musicErrorText(new MusicAutoQueueRerollEmptyError(), texts.ja)).toBe(errors.rerollEmpty);
    expect(musicErrorText(new MusicAutoQueueRerollEmptyError("Jay Chou"), texts.ja)).toBe(errors.rerollEmptyArtist({ artist: "Jay Chou" }));
    expect(musicErrorText(new MusicAutoQueueVoteClosedError(), texts.ja)).toBe(errors.voteClosed);
    expect(musicErrorText(new MusicAutoQueueRerollLimitError(3), texts.ja)).toBe(errors.rerollLimit({ limit: 3 }));
  });

  it("picks the singular or plural rate-limit message", () => {
    expect(musicErrorText(new MusicRateLimitError(1), texts.en)).toContain("in 1 second.");
    expect(musicErrorText(new MusicRateLimitError(4), texts.en)).toContain("in 4 seconds.");
  });

  it("uses the server's language when a translation exists", () => {
    const translated = buildTexts(en, {
      xx: { "music.error.voiceRequired": "Join voice first!", "music.error.rateLimitMany": "Wait {seconds}s." },
    }).texts.xx as Texts;

    expect(musicErrorText(new MusicVoiceChannelRequiredError(), translated)).toBe("Join voice first!");
    expect(musicErrorText(new MusicRateLimitError(3), translated)).toBe("Wait 3s.");
  });

  it("falls back to an unmapped MusicError's own message", () => {
    expect(musicErrorText(new MusicError("Something specific went wrong."), texts.ja)).toBe(
      "Something specific went wrong.",
    );
  });
});
