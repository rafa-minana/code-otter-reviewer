// Reviewer tuning knobs (ARCHITECTURE.md §5).
// shortcut: fixed values, no env override and no per-model context size; add both when a model needs it.

export const REVIEW_MAX_INPUT_TOKENS = 32_000;
export const REVIEW_MAX_CALLS = 3;
export const REVIEW_MAX_FINDINGS = 3;
export const REVIEW_MIN_SCORE = 7; // verifier score 0..10 needed to publish
export const OUTPUT_RESERVE_TOKENS = 4_000;
export const MAX_DESCRIPTION_CHARS = 4_000; // the description is untrusted: it must not eat the diff budget

export const RISKS = ["low", "medium", "high"] as const;

/** Per LLM call: a hung provider fails the attempt (and Graphile retries) instead of blocking the worker forever. */
export const LLM_TIMEOUT_MS = 250_000;

/** Values of LLM_REASONING, passed as the AI SDK's provider-agnostic `reasoning` option. */
export const LLM_REASONING_LEVELS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** `language` values accepted in .otter.yaml, and the name the model is told to write in. */
export const LANGUAGES = { en: "English", es: "Spanish" } as const;

/** Dynamic context (ARCHITECTURE.md §5, step 3): extra lines around each hunk, from the full file. */
export const CONTEXT_LINES_BEFORE = 7;
export const CONTEXT_LINES_AFTER = 7;
/** How much further up to look for the enclosing function named in the `@@ … @@ <function>` header. */
export const FUNCTION_HEADER_SEARCH_LINES = 10;

/** Never worth reviewing: lockfiles, generated, vendored, minified and build output. */
export const DEFAULT_IGNORE = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/*.generated.*",
  "**/*.pb.go",
];
