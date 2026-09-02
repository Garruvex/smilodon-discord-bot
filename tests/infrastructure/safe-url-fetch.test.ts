import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
const lookupCallbackMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]): unknown => lookupMock(...args) },
  lookup: (...args: unknown[]): unknown => lookupCallbackMock(...args),
}));

vi.mock("undici", () => ({
  fetch: (...args: unknown[]): unknown => fetchMock(...args),
  Agent: class {
    public constructor(_options?: unknown) {}
  },
}));

const { fetchLinkContent, guardedLookup } = await import("../../src/infrastructure/net/safe-url-fetch.js");

interface FakeResponseOptions {
  status?: number;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
}

interface FakeReadResult {
  done: boolean;
  value?: Uint8Array;
}

function fakeResponse(options: FakeResponseOptions): unknown {
  const status = options.status ?? 200;
  const headerMap = new Map(Object.entries(options.headers ?? {}));
  if (options.contentType) headerMap.set("content-type", options.contentType);
  const bodyText = options.body ?? "";
  const bytes = new TextEncoder().encode(bodyText);
  let served = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string): string | null => headerMap.get(name.toLowerCase()) ?? null },
    body: {
      getReader: () => ({
        read: (): Promise<FakeReadResult> => {
          if (served) return Promise.resolve({ done: true });
          served = true;
          return Promise.resolve({ done: false, value: bytes });
        },
        cancel: (): Promise<void> => Promise.resolve(),
      }),
    },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(bytes.buffer),
  };
}

function fakeLookupResult(hostname: string): Promise<{ address: string; family: number }> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return Promise.resolve({ address: hostname, family: 4 });
  return Promise.resolve({ address: "93.184.216.34", family: 4 });
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupCallbackMock.mockReset();
  fetchMock.mockReset();
  lookupMock.mockImplementation(fakeLookupResult);
});

describe("guardedLookup", () => {
  // undici's Agent always invokes the custom `connect.lookup` with
  // `{ all: true }`, expecting an (err, addresses[]) callback — the shape
  // bug that shipped originally used the wrong callback signature here and
  // silently broke every real fetch (see the incident this test guards
  // against). These tests call the callback-style dns.lookup directly,
  // bypassing the fully-mocked `undici.fetch` used everywhere else in this
  // file, since that mock never actually exercises this function.
  it("requests all resolved addresses and passes the public ones through in the same shape", () => {
    lookupCallbackMock.mockImplementation((_hostname: string, _options: unknown, cb: unknown) => {
      (cb as (err: null, addrs: { address: string; family: number }[]) => void)(null, [
        { address: "93.184.216.34", family: 4 },
      ]);
    });
    const resultCallback = vi.fn();
    guardedLookup("example.com", { all: true }, resultCallback as never);
    expect(lookupCallbackMock).toHaveBeenCalledWith("example.com", { all: true }, expect.any(Function));
    expect(resultCallback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects when every resolved address is private", () => {
    lookupCallbackMock.mockImplementation((_hostname: string, _options: unknown, cb: unknown) => {
      (cb as (err: null, addrs: { address: string; family: number }[]) => void)(null, [
        { address: "127.0.0.1", family: 4 },
      ]);
    });
    const resultCallback = vi.fn();
    guardedLookup("internal.example.com", { all: true }, resultCallback as never);
    expect(resultCallback).toHaveBeenCalledWith(expect.any(Error), []);
  });

  it("filters out only the private addresses when a hostname resolves to a mix", () => {
    lookupCallbackMock.mockImplementation((_hostname: string, _options: unknown, cb: unknown) => {
      (cb as (err: null, addrs: { address: string; family: number }[]) => void)(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ]);
    });
    const resultCallback = vi.fn();
    guardedLookup("mixed.example.com", { all: true }, resultCallback as never);
    expect(resultCallback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("fetchLinkContent", () => {
  it("rejects non-http(s) protocols", async () => {
    const result = await fetchLinkContent("ftp://example.com/file.txt");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL", async () => {
    const result = await fetchLinkContent("not a url");
    expect(result.ok).toBe(false);
  });

  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["172.16.0.5"],
    ["192.168.1.1"],
    ["169.254.1.1"],
    ["0.0.0.0"],
  ])("rejects the IP-literal private address http://%s/", async (host) => {
    const result = await fetchLinkContent(`http://${host}/`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private|internal/);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValueOnce({ address: "127.0.0.1", family: 4 });
    const result = await fetchLinkContent("http://internal.example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private|internal/);
  });

  it("extracts readable text from HTML, stripping scripts/styles and decoding entities", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({
      contentType: "text/html; charset=utf-8",
      body: "<html><head><style>.x{color:red}</style></head><body>" +
        "<script>evil()</script><p>Hello &amp; welcome</p></body></html>",
    }));
    const result = await fetchLinkContent("https://example.com/article");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Hello & welcome");
      expect(result.text).not.toMatch(/evil|color:red/);
    }
  });

  it("truncates long text with a marker", async () => {
    const longText = "a".repeat(7000);
    fetchMock.mockResolvedValueOnce(fakeResponse({ contentType: "text/plain", body: longText }));
    const result = await fetchLinkContent("https://example.com/big");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.endsWith("[truncated]")).toBe(true);
      expect(result.text.length).toBeLessThan(7000);
    }
  });

  it("rejects disallowed content types without reading the body", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ contentType: "application/pdf", body: "%PDF-1.4" }));
    const result = await fetchLinkContent("https://example.com/file.pdf");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-2xx status", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 404, contentType: "text/html", body: "gone" }));
    const result = await fetchLinkContent("https://example.com/missing");
    expect(result.ok).toBe(false);
  });

  it("enforces the byte cap while streaming", async () => {
    const hugeBytes = new Uint8Array(2 * 1024 * 1024).fill(97);
    let served = false;
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: (name: string): string | null => (name.toLowerCase() === "content-type" ? "text/plain" : null) },
      body: {
        getReader: () => ({
          read: (): Promise<FakeReadResult> => {
            if (served) return Promise.resolve({ done: true });
            served = true;
            return Promise.resolve({ done: false, value: hugeBytes });
          },
          cancel: (): Promise<void> => Promise.resolve(),
        }),
      },
    });
    const result = await fetchLinkContent("https://example.com/huge");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/large/);
  });

  it("follows a redirect and re-validates the target, rejecting a redirect to a private address", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({
      status: 302,
      headers: { location: "http://internal.example.com/secret" },
    }));
    lookupMock.mockImplementationOnce(() => Promise.resolve({ address: "93.184.216.34", family: 4 }));
    lookupMock.mockImplementationOnce(() => Promise.resolve({ address: "10.0.0.5", family: 4 }));
    const result = await fetchLinkContent("https://example.com/redirect");
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a valid redirect through to a successful fetch", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({
      status: 301,
      headers: { location: "https://example.com/final" },
    }));
    fetchMock.mockResolvedValueOnce(fakeResponse({ contentType: "text/plain", body: "final content" }));
    const result = await fetchLinkContent("https://example.com/redirect");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("final content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
