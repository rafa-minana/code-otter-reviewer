import {
  CHECK_MAX_ATTEMPTS,
  checkQueueName,
  TASKS,
  type CheckJob,
  type CheckState,
  type ReviewJob,
} from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import type { CheckRun, GitHubClient } from "./ports.js";
import { getTranslation, TRANSLATIONS } from "./translations/index.js";
import type { Language, TranslationKey } from "./types/translations.js";

/** Saved by each review from its .otter.yaml; until the repo's first review, English. */
const LANGUAGE_SQL = `SELECT language FROM repos WHERE owner = $1 AND name = $2`;
const SAVE_LANGUAGE_SQL = `UPDATE repos SET language = $3 WHERE owner = $1 AND name = $2`;

/** First line of the error, bounded: the check is public to everyone on the PR. */
const MAX_ERROR_CHARS = 300;

/** The check run for a state of the review: only the state, in the repo's language. */
export function renderCheck(job: CheckJob, language: Language): CheckRun {
  const t = (key: TranslationKey) => getTranslation(key, language);
  switch (job.state) {
    case "queued":
    case "in_progress":
      return { status: job.state, title: t(`check.${job.state}`), summary: t(`check.${job.state}.summary`) };
    case "deferred":
      return {
        status: "queued",
        title: t(`check.deferred.${job.why}`),
        summary: t("check.deferred.summary").replace("{time}", job.until.slice(11, 16)),
      };
    case "published": {
      const url = `https://github.com/${job.owner}/${job.repo}/pull/${job.number}#pullrequestreview-${job.githubReviewId}`;
      return {
        status: "completed",
        conclusion: "success",
        title: `${t("check.published").replace("{findings}", String(job.findings))} · ${t(`risk.${job.risk}`)}`,
        summary: `[${t("check.published.summary")}](${url})`,
        detailsUrl: url,
      };
    }
    case "superseded":
    case "closed":
      return { status: "completed", conclusion: "skipped", title: t(`check.${job.state}`), summary: t(`check.${job.state}.summary`) };
    case "failed": {
      const error = job.error.split("\n")[0].slice(0, MAX_ERROR_CHARS);
      return {
        status: "completed",
        conclusion: "neutral", // never blocks a merge, even as a required check
        title: t("check.failed"),
        summary: `${t("check.failed.summary")}\n\n\`\`\`\n${error}\n\`\`\``,
      };
    }
  }
}

/**
 * Checks job handler, on its own runner (index.ts) so it never waits for a free review slot.
 * A missing permission (the installation hasn't accepted Checks yet) or a gone repo is logged, not retried:
 * the review itself never depends on its check.
 */
export async function handleCheck(deps: { gh: GitHubClient }, job: CheckJob, helpers: JobHelpers): Promise<void> {
  const saved = await helpers.withPgClient(async (pg) => (await pg.query(LANGUAGE_SQL, [job.owner, job.repo])).rows[0]?.language);
  const language: Language = Object.hasOwn(TRANSLATIONS, saved ?? "") ? saved : "en";
  try {
    await deps.gh.upsertCheckRun(job, job.sha, renderCheck(job, language));
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 403 && status !== 404 && status !== 422) throw err;
    helpers.logger.warn(`check run of ${job.owner}/${job.repo}@${job.sha} not set (${status}): ${(err as Error).message}`);
  }
}

/** Queues a state change of the review's check run; a failure here never fails the review. */
export async function queueCheck(helpers: JobHelpers, job: ReviewJob, check: CheckState): Promise<void> {
  const { installationId, owner, repo, number, sha } = job;
  const payload: CheckJob = { installationId, owner, repo, number, sha, ...check };
  await helpers
    .addJob(TASKS.checks, payload, { queueName: checkQueueName(job), maxAttempts: CHECK_MAX_ATTEMPTS })
    .catch((err: Error) => helpers.logger.error(`could not queue the check of ${owner}/${repo}#${number}: ${err.message}`));
}

/** The repo's .otter.yaml language, for the next check runs. */
export const saveLanguage = (helpers: JobHelpers, job: ReviewJob, language: Language) =>
  helpers.withPgClient((pg) => pg.query(SAVE_LANGUAGE_SQL, [job.owner, job.repo, language]));
