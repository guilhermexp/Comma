export interface MacosSigning {
  /** `-` signs ad hoc: the app launches and updates but is not notarized. */
  identity: string;
  keychain?: string | undefined;
  /** Set only with Developer ID signing; notarization needs a real identity. */
  notaryProfile?: string | undefined;
  developerId: boolean;
}

/**
 * Developer ID signing is opt in: `COMMA_MACOS_SIGN=1` with an identity, plus
 * its keychain when it lives outside the default search list. A notarytool
 * profile adds notarization. Without the switch every release is ad hoc
 * signed, which Apple Silicon requires before it launches any code.
 */
export function resolveMacosSigning(env: NodeJS.ProcessEnv): MacosSigning {
  if (env.COMMA_MACOS_SIGN !== "1") {
    return { identity: "-", developerId: false };
  }
  const identity = env.COMMA_MACOS_SIGN_IDENTITY?.trim();
  if (!identity || identity === "-") {
    throw new Error("COMMA_MACOS_SIGN=1 requires COMMA_MACOS_SIGN_IDENTITY.");
  }
  return {
    identity,
    keychain: env.COMMA_MACOS_KEYCHAIN?.trim() || undefined,
    notaryProfile: env.COMMA_MACOS_NOTARY_PROFILE?.trim() || undefined,
    developerId: true,
  };
}
