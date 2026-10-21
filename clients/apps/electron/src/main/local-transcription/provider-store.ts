import { existsSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { writePrivateFile } from "../local-backend/files";

/** The part of Electron's safeStorage the store uses; tests pass a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const storedCloudSchema = z
  .object({
    kind: z.enum(["groq", "openai_compatible"]),
    baseUrl: z.string().min(1).max(2048),
    model: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(1024),
  })
  .strict();
export type StoredCloudProvider = z.output<typeof storedCloudSchema>;

/** What the helper runs: Local, or the saved cloud provider. */
export type StoredMeetingProvider = { kind: "local" } | StoredCloudProvider;

// A selected cloud provider is always the saved one.
const storedRecordSchema = z
  .object({
    selected: z.enum(["local", "groq", "openai_compatible"]),
    cloud: storedCloudSchema.optional(),
  })
  .strict()
  .refine(
    (record) => record.selected === "local" || record.cloud?.kind === record.selected,
    "The selected cloud provider has no saved configuration."
  );
export type StoredMeetingRecord = z.output<typeof storedRecordSchema>;

const localRecord: StoredMeetingRecord = { selected: "local" };

/** The provider a record runs. */
export function selectedProvider(record: StoredMeetingRecord): StoredMeetingProvider {
  return record.selected === "local" || !record.cloud
    ? { kind: "local" }
    : record.cloud;
}

/**
 * The meeting transcription provider and its API key (openspec
 * add-cloud-meeting-asr, D2): `{selected, cloud?: {kind, baseUrl, model,
 * apiKey}}` encrypted with safeStorage, whose key lives in the Keychain, in
 * `<dataDir>/asr-provider.bin` (0600). Selecting Local keeps the last cloud
 * configuration, so switching back needs no new key; only deleting the key
 * removes it. Without safeStorage a cloud key is refused; nothing falls back
 * to plain text. Without a cloud key there is no file.
 */
export class MeetingProviderStore {
  readonly #path: string;
  readonly #safeStorage: SafeStorageLike;
  readonly #log: (message: string) => void;

  constructor(options: {
    path: string;
    safeStorage: SafeStorageLike;
    log?: ((message: string) => void) | undefined;
  }) {
    this.#path = options.path;
    this.#safeStorage = options.safeStorage;
    this.#log = options.log ?? (() => undefined);
  }

  /** Whether a cloud provider's key can be stored on this Mac now. */
  available() {
    try {
      return this.#safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** The saved record; Local without a key when none is saved or it cannot be read. */
  read(): StoredMeetingRecord {
    if (!existsSync(this.#path)) return localRecord;
    if (!this.available()) {
      this.#log("The meeting transcription provider is unreadable: no safeStorage.");
      return localRecord;
    }
    try {
      const text = this.#safeStorage.decryptString(readFileSync(this.#path));
      const parsed = storedRecordSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Falls through: an unreadable file never yields a provider.
    }
    this.#log("The saved meeting transcription provider could not be read.");
    return localRecord;
  }

  /** Throws `secure_storage_unavailable` for a cloud key without safeStorage. */
  write(record: StoredMeetingRecord) {
    const parsed = storedRecordSchema.parse(record);
    if (!parsed.cloud) {
      rmSync(this.#path, { force: true });
      return;
    }
    if (!this.available()) throw new Error("secure_storage_unavailable");
    writePrivateFile(
      this.#path,
      this.#safeStorage.encryptString(JSON.stringify(parsed))
    );
  }
}
