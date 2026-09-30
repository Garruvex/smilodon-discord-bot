import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FilePortraitStore } from "../../../src/infrastructure/campaign/image/file-portrait-store.js";
import { pngBytes } from "../../application/campaign/portrait-fakes.js";
import { OpenAiImageStylizer } from "../../../src/infrastructure/campaign/image/openai-image-stylizer.js";

afterEach(() => vi.unstubAllGlobals());

describe("the image edit request", () => {
  const source = { bytes: Buffer.from("upload"), mediaType: "image/jpeg" as const };

  it("sends the picture as the reference with the prompt, and reads the base64 result", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: Buffer.concat([pngBytes, Buffer.from("portrait")]).toString("base64") }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const stylizer = new OpenAiImageStylizer({ apiKey: "key", baseUrl: "https://example.test/v1", model: "gpt-image-2.5-flare" });
    const result = await stylizer.stylize({ source, prompt: "A gnome rogue", timeoutMs: 1000 });
    expect(result.bytes.subarray(pngBytes.length).toString()).toBe("portrait");

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/images/edits");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2.5-flare");
    expect(form.get("prompt")).toBe("A gnome rogue");
    expect(form.has("response_format")).toBe(false);
    const image = form.get("image") as File;
    expect(image.name).toBe("reference.jpg");
    expect(image.type).toBe("image/jpeg");
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe("upload");
  });

  it("asks older models for base64, and reports a provider failure", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), { status: 200 })).mockResolvedValueOnce(new Response("no", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const stylizer = new OpenAiImageStylizer({ apiKey: "key", baseUrl: "https://example.test/v1", model: "dall-e-2" });
    await stylizer.stylize({ source, prompt: "p", timeoutMs: 1000 });
    expect(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData).get("response_format")).toBe("b64_json");
    await expect(stylizer.stylize({ source, prompt: "p", timeoutMs: 1000 })).rejects.toThrow("answered 400");
  });
});

describe("the portrait files", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function store(): Promise<{ store: FilePortraitStore; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "portraits-"));
    dirs.push(dir);
    return { store: new FilePortraitStore(dir), dir };
  }

  it("keeps a portrait, a candidate and a note apart, and forgets a character wholly", async () => {
    const { store: files } = await store();
    await files.saveImage("lc-1", "portrait", { bytes: Buffer.from("a"), mediaType: "image/png" });
    await files.saveImage("lc-1", "candidate", { bytes: Buffer.from("b"), mediaType: "image/webp" });
    await files.saveNote("lc-1", '{"style":"ink"}');
    expect((await files.loadImage("lc-1", "portrait"))?.bytes.toString()).toBe("a");
    expect(await files.loadImage("lc-1", "candidate")).toMatchObject({ mediaType: "image/webp" });
    expect(await files.loadNote("lc-1")).toBe('{"style":"ink"}');
    // Saving over a slot in another type leaves one file, not two.
    await files.saveImage("lc-1", "portrait", { bytes: Buffer.from("c"), mediaType: "image/jpeg" });
    expect(await files.loadImage("lc-1", "portrait")).toMatchObject({ mediaType: "image/jpeg" });
    await files.removeImage("lc-1", "candidate");
    expect(await files.loadImage("lc-1", "candidate")).toBeUndefined();
    await files.removeAll("lc-1");
    expect(await files.loadImage("lc-1", "portrait")).toBeUndefined();
    expect(await files.loadNote("lc-1")).toBeUndefined();
  });

  it("cannot be steered out of its folder by an odd character ID", async () => {
    const { store: files, dir } = await store();
    await files.saveImage("../../escape", "portrait", { bytes: Buffer.from("a"), mediaType: "image/png" });
    expect((await files.loadImage("../../escape", "portrait"))?.bytes.toString()).toBe("a");
    await writeFile(join(dir, "marker"), "x");
    await files.removeAll("../../escape");
    expect(await files.loadImage("../../escape", "portrait")).toBeUndefined();
  });

  it("sweeps old drafts but never a portrait", async () => {
    const { store: files, dir } = await store();
    await files.saveImage("lc-1", "portrait", { bytes: Buffer.from("keep"), mediaType: "image/png" });
    await files.saveImage("lc-1", "source", { bytes: Buffer.from("old"), mediaType: "image/png" });
    await files.saveImage("lc-2", "candidate", { bytes: Buffer.from("fresh"), mediaType: "image/png" });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, "lc-1", "source.png"), old, old);
    await utimes(join(dir, "lc-1", "portrait.png"), old, old);
    expect(await files.sweepDrafts(24 * 60 * 60 * 1000)).toBe(1);
    expect(await files.loadImage("lc-1", "source")).toBeUndefined();
    expect((await files.loadImage("lc-1", "portrait"))?.bytes.toString()).toBe("keep");
    expect((await files.loadImage("lc-2", "candidate"))?.bytes.toString()).toBe("fresh");
  });
});
