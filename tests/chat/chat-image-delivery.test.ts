import { describe, expect, it } from "vitest";

import { planImageDelivery } from "../../src/application/chat/chat-image-delivery.js";
import type { GeneratedChatImage } from "../../src/application/chat/chat-provider.js";

function image(bytes: number, filename = "image.png"): GeneratedChatImage {
  return { data: Buffer.alloc(bytes), contentType: "image/png", filename };
}

const oneMiB = 1024 * 1024;

describe("planImageDelivery", () => {
  it("keeps everything in one group when comfortably under the aggregate limit", () => {
    const images = [image(oneMiB), image(oneMiB)];

    const plan = planImageDelivery(images, 10 * oneMiB);

    expect(plan.groups).toEqual([images]);
    expect(plan.undeliverable).toHaveLength(0);
  });

  it("stays in one group for a payload immediately below the aggregate limit", () => {
    // 4 images just under 2.5 MiB each (plus per-file overhead) sums to just
    // under the 10 MiB aggregate cap.
    const images = [image(2.4 * oneMiB), image(2.4 * oneMiB), image(2.4 * oneMiB), image(2.4 * oneMiB)];

    const plan = planImageDelivery(images, 10 * oneMiB);

    expect(plan.groups).toEqual([images]);
    expect(plan.undeliverable).toHaveLength(0);
  });

  it("splits into a second group for a payload immediately above the aggregate limit", () => {
    // Same as above but pushed just over the cap by one more image.
    const images = [image(2.4 * oneMiB), image(2.4 * oneMiB), image(2.4 * oneMiB), image(2.4 * oneMiB), image(oneMiB)];

    const plan = planImageDelivery(images, 10 * oneMiB);

    expect(plan.groups.length).toBeGreaterThan(1);
    expect(plan.groups.flat()).toHaveLength(images.length);
    expect(plan.undeliverable).toHaveLength(0);
  });

  it("splits four 10 MiB generated images (the real worst case) across multiple messages instead of one 40 MiB request", () => {
    const images = [image(10 * oneMiB), image(10 * oneMiB), image(10 * oneMiB), image(10 * oneMiB)];

    const plan = planImageDelivery(images, 10 * oneMiB);

    // Each image alone is right at the cap once overhead is added, so each
    // gets its own group/message.
    expect(plan.groups).toHaveLength(4);
    for (const group of plan.groups) expect(group).toHaveLength(1);
    expect(plan.undeliverable).toHaveLength(0);
  });

  it("reports an image that could never be delivered, even alone, as undeliverable", () => {
    const tooLarge = image(50 * oneMiB, "huge.png");
    const normal = image(oneMiB);

    const plan = planImageDelivery([tooLarge, normal], 10 * oneMiB);

    expect(plan.undeliverable).toEqual([tooLarge]);
    expect(plan.groups.flat()).toEqual([normal]);
  });

  it("returns no groups and no undeliverable images for an empty input", () => {
    const plan = planImageDelivery([], 10 * oneMiB);

    expect(plan.groups).toHaveLength(0);
    expect(plan.undeliverable).toHaveLength(0);
  });
});
