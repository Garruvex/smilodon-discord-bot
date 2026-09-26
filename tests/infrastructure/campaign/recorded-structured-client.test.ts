import { describe, expect, it } from "vitest";

import type {
  StructuredModelClient,
  StructuredModelRequest,
} from "../../../src/application/campaign/ports/structured-model-client.js";
import {
  RecordingStructuredClient,
  ReplayStructuredClient,
  requestKey,
} from "../../../src/infrastructure/campaign/llm/recorded-structured-client.js";

const request = (user: string): StructuredModelRequest => ({
  system: "Be fair.",
  user,
  schemaName: "test",
  jsonSchema: {},
  maxOutputTokens: 100,
  timeoutMs: 1000,
});

class Counting implements StructuredModelClient {
  public readonly name = "counting";
  public calls = 0;
  public generate(): ReturnType<StructuredModelClient["generate"]> {
    this.calls += 1;
    return Promise.resolve({ text: `answer ${this.calls}`, model: "m", usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0 } });
  }
}

describe("recorded model calls", () => {
  it("replays what a live run recorded, in order for identical requests, at no cost", async () => {
    const live = new Counting();
    const recorder = new RecordingStructuredClient(live);
    await recorder.generate(request("a"));
    await recorder.generate(request("b"));
    await recorder.generate(request("a"));
    expect(recorder.name).toBe("recording(counting)");

    // A recording survives being saved as JSON.
    const saved = JSON.parse(JSON.stringify(recorder.calls)) as typeof recorder.calls;
    const replay = new ReplayStructuredClient(saved);
    expect((await replay.generate(request("a"))).text).toBe("answer 1");
    expect((await replay.generate(request("b"))).text).toBe("answer 2");
    expect((await replay.generate(request("a"))).text).toBe("answer 3");
    expect(live.calls).toBe(3);
  });

  it("fails loudly when the prompt changed or the recording is used up", async () => {
    const recorder = new RecordingStructuredClient(new Counting());
    await recorder.generate(request("a"));
    const replay = new ReplayStructuredClient(recorder.calls);
    await expect(replay.generate(request("changed"))).rejects.toThrow("re-record");
    await replay.generate(request("a"));
    await expect(replay.generate(request("a"))).rejects.toThrow("re-record");
  });

  it("keys a request by what the model was asked, not by limits", () => {
    expect(requestKey(request("a"))).toBe(requestKey({ ...request("a"), maxOutputTokens: 5 }));
    expect(requestKey(request("a"))).not.toBe(requestKey(request("b")));
  });
});
