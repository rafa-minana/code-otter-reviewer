import type { Language, TranslationKey, Translations } from "../types/translations.js";
import en from "./en.json" with { type: "json" };
import es from "./es.json" with { type: "json" };

// Typed as Translations, so a key missing from a JSON file fails the build.
export const TRANSLATIONS: Record<Language, Translations> = { en, es };

/** Fixed texts of the published review; the LLM writes the rest in the same language. */
export const getTranslation = (key: TranslationKey, language: Language): string =>
  TRANSLATIONS[language][key];
