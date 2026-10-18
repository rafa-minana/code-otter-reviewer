import type { ReviewerOutput } from "@otter/contracts";
import type en from "../translations/en.json";

export type Language = ReviewerOutput["language"];

/** Every key of the reference language file (en.json); the other languages must have the same ones. */
export type TranslationKey = keyof typeof en;

/** One language file: every key, flat. */
export type Translations = Record<TranslationKey, string>;
