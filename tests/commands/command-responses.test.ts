import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandResponses } from "../../src/application/commands/command-responses.js";
import { CommandResponseVisibility } from "../../src/application/commands/command.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandResponses", () => {
  it("deletes a transient interaction response after its requested lifetime", async () => {
    vi.useFakeTimers();
    const deleteReply = vi.fn().mockResolvedValue(undefined);
    const responses = new CommandResponses(
      { deleteReply } as never,
      CommandResponseVisibility.Public,
    );

    responses.deleteAfter(30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(deleteReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteReply).toHaveBeenCalledOnce();
  });
});
