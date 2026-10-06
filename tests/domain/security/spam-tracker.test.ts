import { describe, expect, it } from "vitest";

import { SpamTracker, spamFingerprint } from "../../../src/domain/security/spam-tracker.js";

const window = 60_000;
const post = (channelId: string, at: number): { channelId: string; messageId: string; at: number } =>
  ({ channelId, messageId: `${channelId}-${at}`, at });

describe("spamFingerprint", () => {
  it("treats the same text as the same message whatever its spacing or case", () => {
    expect(spamFingerprint("Free  NITRO here", [])).toBe(spamFingerprint("free nitro here", []));
  });

  it("ignores short messages with nothing attached", () => {
    expect(spamFingerprint("lol", [])).toBeNull();
    expect(spamFingerprint("   ", [])).toBeNull();
  });

  it("counts a short message that is a link", () => {
    expect(spamFingerprint("http://a.co", [])).not.toBeNull();
  });

  it("marks a message by its links, so rewording around one doesn't help", () => {
    const one = spamFingerprint("free nitro!! https://Scam.example/claim.", []);
    const two = spamFingerprint("claim it now www.scam.example/claim", []);
    expect(one).toBe(two);
    expect(one).not.toBe(spamFingerprint("https://other.example/claim", []));
  });

  it("tells apart messages that link to different places", () => {
    expect(spamFingerprint("see https://a.example/1", [])).not.toBe(spamFingerprint("see https://a.example/2", []));
  });

  it("fingerprints files by name and size when there is no text", () => {
    const files = [{ name: "Scam.PNG", size: 10 }];
    expect(spamFingerprint("", files)).toBe(spamFingerprint("", [{ name: "scam.png", size: 10 }]));
    expect(spamFingerprint("", files)).not.toBe(spamFingerprint("", [{ name: "scam.png", size: 11 }]));
  });
});

describe("SpamTracker", () => {
  it("triggers when the same message reaches enough different channels", () => {
    const tracker = new SpamTracker();
    expect(tracker.record("m", "x", post("a", 1_000), window, 3).triggered).toBe(false);
    expect(tracker.record("m", "x", post("b", 2_000), window, 3).triggered).toBe(false);
    const verdict = tracker.record("m", "x", post("c", 3_000), window, 3);
    expect(verdict.triggered).toBe(true);
    expect(verdict.channels).toBe(3);
    expect(verdict.posts.map((entry) => entry.channelId)).toEqual(["a", "b", "c"]);
  });

  it("doesn't count the same channel twice", () => {
    const tracker = new SpamTracker();
    for (let i = 0; i < 6; i += 1) {
      expect(tracker.record("m", "x", post("a", 1_000 + i), window, 3).triggered).toBe(false);
    }
  });

  it("forgets posts that fall out of the window", () => {
    const tracker = new SpamTracker();
    tracker.record("m", "x", post("a", 0), window, 3);
    tracker.record("m", "x", post("b", 1_000), window, 3);
    expect(tracker.record("m", "x", post("c", 200_000), window, 3).triggered).toBe(false);
  });

  it("keeps different messages and different members apart", () => {
    const tracker = new SpamTracker();
    tracker.record("m", "x", post("a", 1_000), window, 3);
    tracker.record("m", "y", post("b", 2_000), window, 3);
    tracker.record("other", "x", post("c", 3_000), window, 3);
    expect(tracker.record("m", "x", post("d", 4_000), window, 3).triggered).toBe(false);
  });

  it("reports a burst once, then starts over", () => {
    const tracker = new SpamTracker();
    for (const channel of ["a", "b", "c"]) tracker.record("m", "x", post(channel, 1_000), window, 3);
    expect(tracker.record("m", "x", post("d", 2_000), window, 3).triggered).toBe(false);
  });
});
