import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { authoringGuideModule } from "../../../src/scripts/build-authoring-guide.js";

// The Adventure Author reads a copy of the docs that is generated into the source tree (the runtime image has no docs/). When someone edits the guide, the
// reference or the template and forgets `npm run adventure:guide`, the Author would be reading old instructions, so this fails until it is regenerated.
describe("the authoring guide the Adventure Author reads", () => {
  it("is the current docs", () => {
    const generated = readFileSync(new URL("../../../src/application/campaign/adventures/authoring-guide.generated.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    expect(generated).toBe(authoringGuideModule());
  });
});
