import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkProviderUrl,
  verifyProviderKey,
} from "../local-transcription/provider-verification";

const key = "sk-test-verification-key";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

/** A loopback OpenAI-compatible provider whose /models answers `status`. */
async function provider(status: number) {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200 ? { data: [] } : { error: {} }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

const config = (baseUrl: string) => ({
  kind: "openai_compatible" as const,
  baseUrl,
  model: "whisper-1",
  apiKey: key,
});

describe("checking a provider URL", () => {
  it.each([
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1"],
    ["http://localhost:9000", "http://localhost:9000"],
  ])("accepts %s", (input, normalized) => {
    expect(checkProviderUrl(input)).toEqual({ ok: true, baseUrl: normalized });
  });

  it.each([
    ["http://asr.example.com/v1", "insecure_url"],
    ["http://192.168.1.4/v1", "insecure_url"],
    ["ftp://asr.example.com", "insecure_url"],
    ["not a url", "invalid_url"],
    ["https://user:secret@asr.example.com/v1", "invalid_url"],
  ])("refuses %s", (input, reason) => {
    expect(checkProviderUrl(input)).toEqual({ ok: false, reason });
  });
});

describe("verifying a provider key (D7)", () => {
  it("accepts a key the provider's /models answers with 200, sending it as a Bearer", async () => {
    const { baseUrl, requests } = await provider(200);
    const helperVerify = vi.fn();
    expect(await verifyProviderKey(config(baseUrl), { helperVerify })).toBe("valid");
    expect(requests).toEqual([{ url: "/v1/models", authorization: `Bearer ${key}` }]);
    expect(helperVerify).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "reports a key the provider refuses with %i as rejected",
    async (status) => {
      const { baseUrl } = await provider(status);
      expect(await verifyProviderKey(config(baseUrl), { helperVerify: vi.fn() })).toBe(
        "rejected"
      );
    }
  );

  it("reports an unreachable provider", async () => {
    const { baseUrl } = await provider(200);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await verifyProviderKey(config(baseUrl), { helperVerify: vi.fn() })).toBe(
      "unreachable"
    );
  });

  it("reports a provider error", async () => {
    const { baseUrl } = await provider(503);
    expect(await verifyProviderKey(config(baseUrl), { helperVerify: vi.fn() })).toBe(
      "server_error"
    );
  });

  it.each([404, 405])(
    "asks the helper for a test transcription when /models answers %i",
    async (status) => {
      const { baseUrl } = await provider(status);
      const helperVerify = vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, reason: "cloud_auth_rejected" });
      expect(await verifyProviderKey(config(baseUrl), { helperVerify })).toBe("valid");
      expect(await verifyProviderKey(config(baseUrl), { helperVerify })).toBe(
        "rejected"
      );
      expect(helperVerify).toHaveBeenCalledWith(config(baseUrl));
    }
  );

  it("treats a helper that cannot answer the test as unreachable", async () => {
    const { baseUrl } = await provider(404);
    const helperVerify = vi.fn().mockRejectedValue(new Error("helper is down"));
    expect(await verifyProviderKey(config(baseUrl), { helperVerify })).toBe(
      "unreachable"
    );
  });

  it("never sends the key to a plain-HTTP host that is not this Mac", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await verifyProviderKey(config("http://asr.example.com/v1"), {
        helperVerify: vi.fn(),
        fetch: fetcher,
      })
    ).toBe("insecure_url");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
