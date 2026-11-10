import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckJob, CheckState } from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import { handleCheck, renderCheck } from "./checks.js";
import type { CheckRun, GitHubClient } from "./ports.js";

const job = (check: CheckState): CheckJob => ({
  installationId: 1,
  owner: "acme",
  repo: "app",
  number: 7,
  sha: "a".repeat(40),
  ...check,
});

test("renderCheck: each state's status, conclusion and title, in the repo's language", () => {
  const cases: [CheckState, string, string | undefined, string][] = [
    [{ state: "queued" }, "queued", undefined, "En cola"],
    [{ state: "in_progress" }, "in_progress", undefined, "Revisando"],
    [{ state: "deferred", why: "quota", until: "2026-11-11T00:01:00.000Z" }, "queued", undefined, "Aplazada: se agotó el cupo de IA"],
    [{ state: "published", githubReviewId: 9, findings: 2, risk: "high" }, "completed", "success", "Revisión publicada: 2 hallazgos · Riesgo: alto"],
    [{ state: "superseded" }, "completed", "skipped", "Omitida: hay un commit más nuevo"],
    [{ state: "closed" }, "completed", "skipped", "Omitida: la PR se cerró"],
    [{ state: "failed", error: "boom" }, "completed", "neutral", "No se pudo revisar este commit"],
  ];
  for (const [check, status, conclusion, title] of cases) {
    const run = renderCheck(job(check), "es");
    assert.deepEqual([run.status, run.conclusion, run.title], [status, conclusion, title], check.state);
  }
});

test("renderCheck: the wake-up time, the review link, and only the first line of an error", () => {
  const deferred = renderCheck(job({ state: "deferred", why: "overloaded", until: "2026-11-10T10:50:00.000Z" }), "en");
  assert.equal(deferred.summary, "It will be retried around 10:50 UTC.");

  const published = renderCheck(job({ state: "published", githubReviewId: 9, findings: 0, risk: "low" }), "en");
  assert.equal(published.detailsUrl, "https://github.com/acme/app/pull/7#pullrequestreview-9");

  const failed = renderCheck(job({ state: "failed", error: `LLM quota: gave up\n${"stderr ".repeat(100)}` }), "en");
  assert.match(failed.summary, /```\nLLM quota: gave up\n```/);
});

const helpers = (language: string | null, warnings: string[]) =>
  ({
    withPgClient: async (fn: (pg: unknown) => unknown) =>
      fn({ query: async () => ({ rows: language === null ? [] : [{ language }] }) }),
    logger: { warn: (m: string) => void warnings.push(m) },
  }) as unknown as JobHelpers;

test("handleCheck: renders in the saved language (English before the repo's first review)", async () => {
  const runs: CheckRun[] = [];
  const gh = { upsertCheckRun: async (_r: unknown, _s: string, run: CheckRun) => void runs.push(run) } as unknown as GitHubClient;
  await handleCheck({ gh }, job({ state: "queued" }), helpers("es", []));
  await handleCheck({ gh }, job({ state: "queued" }), helpers(null, []));
  assert.deepEqual(runs.map((r) => r.title), ["En cola", "Queued"]);
});

test("handleCheck: a missing Checks permission is logged, not retried; other errors are", async () => {
  const failing = (status: number) =>
    ({ upsertCheckRun: async () => { throw Object.assign(new Error("nope"), { status }); } }) as unknown as GitHubClient;
  const warnings: string[] = [];
  await handleCheck({ gh: failing(403) }, job({ state: "queued" }), helpers("en", warnings));
  assert.equal(warnings.length, 1);
  await assert.rejects(handleCheck({ gh: failing(500) }, job({ state: "queued" }), helpers("en", [])));
});
