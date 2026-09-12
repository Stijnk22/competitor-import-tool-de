/**
 * Supported languages
 *
 * English only (American/British) — the other languages (Dutch, German,
 * Danish) were removed after repeatedly finding that the AI would
 * sometimes drift into a different language partway through longer,
 * structured content (e.g. French/Dutch, despite the instruction). This
 * issue never occurred with English target languages.
 */
export const SUPPORTED_LANGUAGES = {
  "en-US": "American English",
  "en-GB": "British English",
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;

export const DEFAULT_LANGUAGE: LanguageCode = "en-GB";

export function isValidLanguageCode(value: string): value is LanguageCode {
  return value in SUPPORTED_LANGUAGES;
}
