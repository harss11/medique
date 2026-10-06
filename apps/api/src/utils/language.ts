/** Languages MediQ speaks to patients in. English is the fallback for everything. */
export const LANGUAGES = ["en", "hi"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Whatever is stored (an old row, a typo) becomes a language we have text for. */
export function toLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}
