import { request as httpRequest } from "node:http";
import { relative } from "node:path";
import { mintReviewToken } from "@otter/gateway/token.js";
import {
  REVIEW_CONTAINER_TIMEOUT_MS,
  REVIEWER_LLM_ENV,
  type LaunchRequest,
  type LaunchResult,
  type ReviewerFailure,
} from "@otter/contracts";
import type { ReviewerConfig } from "./config.js";
import type { ContainerRunner } from "./ports.js";

/** The launcher stops a review container on time; a minute more covers its answer. The call is silent until then. */
const LAUNCH_TIMEOUT_MS = REVIEW_CONTAINER_TIMEOUT_MS + 60_000;
const STDERR_TAIL_CHARS = 2_000;

/** The container's LLM variables: the worker's settings, pointed at the gateway with a fresh token, never the real key. */
export function reviewerEnv(
  cfg: ReviewerConfig,
  reviewId: string,
  base: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): LaunchRequest["env"] {
  const env: LaunchRequest["env"] = {};
  for (const name of REVIEWER_LLM_ENV)
    if (typeof base[name] === "string") env[name] = base[name];
  env.LLM_BASE_URL = cfg.gatewayUrl;
  env.LLM_API_KEY = mintReviewToken(cfg.gatewaySecret, reviewId, now);
  return env;
}

/**
 * Runs the reviewer through the launcher, the only service with the Docker socket. `dataDir` is the root
 * of the data volume: the launcher gets the worktree relative to it.
 */
export function launcherRunner(
  cfg: ReviewerConfig,
  dataDir: string,
): ContainerRunner {
  return {
    async runReviewer(request, worktree, reviewId) {
      const result = await launch(cfg.launcherUrl, {
        reviewId,
        worktree: relative(dataDir, worktree),
        env: reviewerEnv(cfg, reviewId),
        request,
      });
      if (result.exitCode !== 0) throw reviewerError(result);
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new ReviewerError("reviewer container printed no JSON", undefined);
      }
    },
  };
}

/** node:http, not fetch: undici gives up on a response after 300 s, and a review lasts much longer. */
function launch(url: string, body: LaunchRequest): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    // no exit code: the worker retries it like a timeout (busy launcher, restart in progress)
    const fail = (why: string) =>
      reject(new ReviewerError(`reviewer launcher failed: ${why}`, undefined));
    const req = httpRequest(
      `${url}/review`,
      { method: "POST", headers: { "content-type": "application/json" }, timeout: LAUNCH_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => fail(e.message));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) return fail(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
          try {
            resolve(JSON.parse(text) as LaunchResult);
          } catch {
            fail("unreadable answer");
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => fail(e.message));
    req.end(JSON.stringify(body));
  });
}

/**
 * A failed review container; `exitCode` (REVIEWER_EXIT) says whether retrying can help, and
 * `retryAfterSeconds` when an exhausted quota resets, if the reviewer knew. Both come from an untrusted
 * container: the worker bounds the wait.
 */
export class ReviewerError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** From the launcher's result: the container's exit code, its stderr tail and its ReviewerFailure. */
export function reviewerError({ exitCode, stdout, stderr }: LaunchResult): ReviewerError {
  return new ReviewerError(
    `reviewer container failed (exit ${exitCode ?? "?"}): ${stderr.trim().slice(-STDERR_TAIL_CHARS)}`,
    exitCode ?? undefined, // a timeout or a full buffer has no exit code
    retryAfterOf(stdout),
  );
}

function retryAfterOf(stdout: string): number | undefined {
  try {
    const { retryAfterSeconds } = JSON.parse(stdout) as ReviewerFailure;
    return typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? retryAfterSeconds
      : undefined;
  } catch {
    return undefined;
  }
}
