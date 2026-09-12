/**
 * Supported languages
 *
 * This instance targets the German market: product output (title,
 * description, meta, variant option names/values) is generated in German.
 *
 * NOTE on language drift: earlier, non-English target languages were
 * removed because the AI would sometimes drift into a different language
 * partway through longer, structured content (e.g. German sliding into
 * French/Dutch). German is re-enabled here together with a strict,
 * repeated language instruction in the prompt AND a post-generation
 * language-detection safety net (see content-optimizer.ts) that
 * regenerates once if the output isn't predominantly German — so that
 * drift is caught instead of reaching the store.
 */
export const SUPPORTED_LANGUAGES = {
  "de-DE": "German",
  "en-US": "American English",
  "en-GB": "British English",
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;

export const DEFAULT_LANGUAGE: LanguageCode = "de-DE";

export function isValidLanguageCode(value: string): value is LanguageCode {
  return value in SUPPORTED_LANGUAGES;
}

/**
 * The ISO-639-1 code + human name used by the language-detection safety
 * net. Only target languages that need drift-checking need an entry; for
 * English variants the check is effectively a no-op (English rarely
 * drifts), but they're included for completeness.
 */
export const LANGUAGE_DETECTION_INFO: Record<LanguageCode, { iso: string; name: string }> = {
  "de-DE": { iso: "de", name: "German" },
  "en-US": { iso: "en", name: "English" },
  "en-GB": { iso: "en", name: "English" },
};
