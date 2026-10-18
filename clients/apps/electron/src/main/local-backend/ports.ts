import { connect, createServer } from "node:net";

/** Every TCP listener of the local backend; all bind 127.0.0.1 only. */
export const localBackendPortNames = [
  "postgres",
  "redis",
  "minio",
  "minioConsole",
  "salix",
  "comma",
  "transfer",
  "metrics",
] as const;

export type LocalBackendPortName = (typeof localBackendPortNames)[number];
export type LocalBackendPorts = Record<LocalBackendPortName, number>;

const loopback = "127.0.0.1";

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: loopback, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: loopback, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * A port is free only when nothing answers on 127.0.0.1 and it can be bound
 * there. The connection probe also catches a listener bound to every
 * interface, which macOS may still let a loopback bind share.
 */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return !(await accepts(port)) && (await bindable(port));
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: loopback, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Keeps each saved port while it is free and replaces any port another
 * program took, so the backend never attaches to a service of another origin.
 */
export async function resolveLocalBackendPorts(
  saved: Partial<Record<string, number>>
): Promise<LocalBackendPorts> {
  const chosen = new Set<number>();
  const ports = {} as LocalBackendPorts;
  for (const name of localBackendPortNames) {
    const previous = saved[name];
    let port: number | undefined =
      typeof previous === "number" &&
      Number.isInteger(previous) &&
      previous > 0 &&
      !chosen.has(previous) &&
      (await isLoopbackPortFree(previous))
        ? previous
        : undefined;
    while (port === undefined) {
      const candidate = await ephemeralPort();
      if (!chosen.has(candidate) && (await isLoopbackPortFree(candidate)))
        port = candidate;
    }
    chosen.add(port);
    ports[name] = port;
  }
  return ports;
}
