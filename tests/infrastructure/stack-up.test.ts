import { describe, expect, it, vi } from "vitest";
import { stackUp } from "../../scripts/stack-up.mjs";

describe("stack release revision", () => {
  it("passes Git HEAD to the image build and starts without an unstamped rebuild", () => {
    const sha = "a".repeat(40);
    const run = vi.fn((command: string, _args: readonly string[]) => ({ status: 0, stdout: command === "git" ? `${sha}\n` : "" }));
    stackUp(run);
    expect(run.mock.calls[1]).toEqual(["docker", ["compose", "-f", "compose.yaml", "-f", "compose.tunnel.yaml", "build", "--build-arg", `BUILD_SHA=${sha}`]]);
    expect(run.mock.calls[2]?.[1]).toContain("--no-build");
  });
  it("does not start the stack after a failed build", () => {
    const run = vi.fn((command: string, _args: readonly string[]) => ({ status: command === "git" ? 0 : 1, stdout: "b".repeat(40) }));
    expect(() => stackUp(run)).toThrow("Docker stack operation failed"); expect(run).toHaveBeenCalledTimes(2);
  });
  it("reports unknown when Git metadata is unavailable", () => {
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const run = vi.fn((command: string, _args: readonly string[]) => ({ status: command === "git" ? 1 : 0, stdout: "" }));
      stackUp(run);
      expect(run.mock.calls[1]?.[1]).toContain("BUILD_SHA=unknown"); expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });
});
