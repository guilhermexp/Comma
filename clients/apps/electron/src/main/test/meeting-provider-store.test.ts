import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MeetingProviderStore,
  type SafeStorageLike,
} from "../local-transcription/provider-store";

const key = "gsk_live_0123456789abcdefSECRET";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A reversible stand-in for Electron's safeStorage that never keeps plaintext. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => {
      if (!available) throw new Error("Encryption is not available.");
      return Buffer.from(Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a));
    },
    decryptString: (data) => {
      if (!available) throw new Error("Encryption is not available.");
      return Buffer.from(data.map((byte) => byte ^ 0x5a)).toString("utf8");
    },
  };
}

function store(safeStorage = fakeSafeStorage()) {
  const dataDir = mkdtempSync(join(tmpdir(), "comma-asr-provider-"));
  dirs.push(dataDir);
  const path = join(dataDir, "asr-provider.bin");
  return { subject: new MeetingProviderStore({ path, safeStorage }), path };
}

const groq = {
  kind: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "whisper-large-v3",
  apiKey: key,
} as const;

describe("meeting transcription provider store", () => {
  it("starts with Local when nothing was saved", () => {
    expect(store().subject.read()).toEqual({ kind: "local" });
  });

  it("writes the configuration encrypted with mode 0600 and reads it back", () => {
    const { subject, path } = store();
    subject.write(groq);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(subject.read()).toEqual(groq);
    // A second store over the same file, as after a restart of the app.
    expect(
      new MeetingProviderStore({ path, safeStorage: fakeSafeStorage() }).read()
    ).toEqual(groq);
  });

  it("never writes the key, the URL or the JSON as plain text", () => {
    const { subject, path } = store();
    subject.write(groq);
    const bytes = readFileSync(path);
    expect(bytes.includes(key)).toBe(false);
    expect(bytes.includes("api.groq.com")).toBe(false);
    expect(bytes.includes("apiKey")).toBe(false);
  });

  it("deletes the file when the provider returns to Local", () => {
    const { subject, path } = store();
    subject.write(groq);
    subject.write({ kind: "local" });
    expect(existsSync(path)).toBe(false);
    expect(subject.read()).toEqual({ kind: "local" });
  });

  it("refuses a cloud provider without safeStorage instead of writing plain text", () => {
    const { subject, path } = store(fakeSafeStorage(false));
    expect(subject.available()).toBe(false);
    expect(() => subject.write(groq)).toThrow("secure_storage_unavailable");
    expect(existsSync(path)).toBe(false);
    // Local needs no key, so it stays available.
    expect(() => subject.write({ kind: "local" })).not.toThrow();
  });

  it("reads Local from a file it cannot decrypt or parse", () => {
    const { subject, path } = store();
    writeFileSync(path, Buffer.from([1, 2, 3]), { mode: 0o600 });
    expect(subject.read()).toEqual({ kind: "local" });
    expect(
      new MeetingProviderStore({ path, safeStorage: fakeSafeStorage(false) }).read()
    ).toEqual({ kind: "local" });
  });
});
