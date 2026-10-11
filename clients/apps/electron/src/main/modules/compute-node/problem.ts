import type { CommaLocale } from "@comma/i18n";

type Message<Inputs> = (inputs: Inputs, options: { locale: CommaLocale }) => string;

/**
 * A failure whose text the user sees as a compute node or Host maintenance
 * problem. The thrown message stays English for logs; the owner that publishes
 * the problem renders it in Main's language at that moment.
 */
export class ComputeProblemError extends Error {
  readonly localize: (locale: CommaLocale) => string;

  constructor(localize: (locale: CommaLocale) => string, options?: ErrorOptions) {
    super(localize("en"), options);
    this.localize = localize;
  }
}

export function computeProblem<Inputs>(
  message: Message<Inputs>,
  inputs: Inputs,
  options?: ErrorOptions
) {
  return new ComputeProblemError((locale) => message(inputs, { locale }), options);
}

/** Published problem text; raw helper, OS and server text passes through unchanged. */
export function problemText(error: unknown, locale: CommaLocale): string | undefined {
  if (error instanceof ComputeProblemError) return error.localize(locale);
  return error instanceof Error ? error.message : undefined;
}
