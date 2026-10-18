import { test } from "node:test";
import assert from "node:assert/strict";
import { getTranslation, TRANSLATIONS } from "./index.js";

test("every language has exactly the same keys (the type only catches missing ones, not extra or misspelled)", () => {
  const [first, ...rest] = Object.values(TRANSLATIONS).map((t) => Object.keys(t).sort());
  for (const keys of rest) assert.deepEqual(keys, first);
});

test("getTranslation resolves a dotted key in the given language", () => {
  assert.equal(getTranslation("risk.high", "es"), "Riesgo: alto");
  assert.equal(getTranslation("severity.nit", "en"), "Nit");
});
