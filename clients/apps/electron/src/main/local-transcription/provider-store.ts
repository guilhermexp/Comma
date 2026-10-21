import { existsSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { writePrivateFile } from "../local-backend/files";

/** The part of Electron's safeStorage the store uses; tests pass a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const storedProviderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.enum(["groq", "openai_compatible"]),
      baseUrl: z.string().min(1).max(2048),
      model: z.string().min(1).max(200),
      apiKey: z.string().min(1).max(1024),
    })
    .strict(),
]);
export type StoredMeetingProvider = z.output<typeof storedProviderSchema>;
export type StoredCloudProvider = Exclude<StoredMeetingProvider, { kind: "local" }>;

/**
 * The meeting transcription provider and its API key (openspec
 * add-cloud-meeting-asr, D2): `{kind, baseUrl, model, apiKey}` encrypted
 * with safeStorage, whose key lives in the Keychain, in
 * `<dataDir>/asr-provider.bin` (0600). Without safeStorage a cloud provider
 * is refused; nothing falls back to plain text. Local writes no file.
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

  /** The saved provider; Local when none is saved or the file cannot be read. */
  read(): StoredMeetingProvider {
    if (!existsSync(this.#path)) return { kind: "local" };
    if (!this.available()) {
      this.#log("The meeting transcription provider is unreadable: no safeStorage.");
      return { kind: "local" };
    }
    try {
      const text = this.#safeStorage.decryptString(readFileSync(this.#path));
      const parsed = storedProviderSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Falls through: an unreadable file never yields a provider.
    }
    this.#log("The saved meeting transcription provider could not be read.");
    return { kind: "local" };
  }

  /** Throws `secure_storage_unavailable` for a cloud provider without safeStorage. */
  write(provider: StoredMeetingProvider) {
    const parsed = storedProviderSchema.parse(provider);
    if (parsed.kind === "local") {
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
