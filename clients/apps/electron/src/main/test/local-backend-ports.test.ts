import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackPortFree,
  localBackendPortNames,
  resolveLocalBackendPorts,
} from "../local-backend/ports";

const servers: Server[] = [];

function listen(host: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once("error", reject);
    server.listen({ host, port }, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

describe("local backend ports", () => {
  it("picks distinct free loopback ports on the first launch", async () => {
    const ports = await resolveLocalBackendPorts({});

    expect(Object.keys(ports).toSorted()).toEqual(
      [...localBackendPortNames].toSorted()
    );
    // The local transcription helper listens on its own loopback port.
    expect(ports.asr).toEqual(expect.any(Number));
    const values = Object.values(ports);
    expect(new Set(values).size).toBe(values.length);
    for (const port of values) expect(await isLoopbackPortFree(port)).toBe(true);
  });

  it("reuses saved ports while they are free", async () => {
    const saved = await resolveLocalBackendPorts({});
    expect(await resolveLocalBackendPorts(saved)).toEqual(saved);
  });

  it("replaces a saved port that another program now occupies", async () => {
    const saved = await resolveLocalBackendPorts({});
    const occupied = await listen("127.0.0.1", saved.comma);

    const next = await resolveLocalBackendPorts(saved);
    expect(next.comma).not.toBe(occupied);
    expect(await isLoopbackPortFree(next.comma)).toBe(true);
    expect({ ...next, comma: saved.comma }).toEqual(saved);
  });

  it("treats a port held on every interface as occupied", async () => {
    const port = await listen("0.0.0.0");
    expect(await isLoopbackPortFree(port)).toBe(false);
  });
});
