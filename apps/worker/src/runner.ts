import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mintReviewToken } from "@otter/gateway/token.js";
import type { ReviewerConfig } from "./config.js";
import type { ContainerRunner } from "./ports.js";

const execFileAsync = promisify(execFile);

/** Mount point of the PR's checkout inside the container (read-only). */
const REPO_MOUNT = "/repo";
/** Each LLM call times out at 3 min; a review makes at most 6, partly in parallel. */
const REVIEW_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;

/**
 * The only variables the container gets, by name: Docker copies each value from the docker CLI's
 * environment (reviewerEnv), so none shows up in argv or `ps`. Never the whole environment: the
 * GitHub key and the database URL must not reach it. LLM_BASE_URL and LLM_API_KEY are always the
 * gateway's URL and this review's token: the real key lives only in the gateway.
 */
export const REVIEWER_LLM_ENV = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_REASONING",
];

/** `docker run` for one review: no privileges, read-only filesystem, the checkout read-only, bounded resources. */
export function dockerRunArgs(
  cfg: ReviewerConfig,
  worktree: string,
  name: string,
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--pull",
    "never", // a same-named image from Docker Hub could be anyone's
    "--network",
    cfg.network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--cpus",
    "1",
    ...REVIEWER_LLM_ENV.flatMap((v) => ["-e", v]),
    "-v",
    `${worktree}:${REPO_MOUNT}:ro`,
    cfg.image,
  ];
}

/** Environment of the docker CLI for one review: the LLM settings, pointed at the gateway with a fresh token. */
export function reviewerEnv(
  cfg: ReviewerConfig,
  reviewId: string,
  base: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): NodeJS.ProcessEnv {
  return {
    ...base,
    LLM_BASE_URL: cfg.gatewayUrl,
    LLM_API_KEY: mintReviewToken(cfg.gatewaySecret, reviewId, now),
  };
}

/** Runs the reviewer image through the Docker socket mounted in the worker. */
export function dockerRunner(cfg: ReviewerConfig): ContainerRunner {
  return {
    async runReviewer(request, worktree, reviewId) {
      const name = `otter-review-${reviewId}`;
      await removeContainer(name); // a leftover of a crashed attempt would clash on the name
      const run = execFileAsync("docker", dockerRunArgs(cfg, worktree, name), {
        env: reviewerEnv(cfg, reviewId),
        timeout: REVIEW_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      run.child.stdin?.end(JSON.stringify(request));
      try {
        const { stdout } = await run;
        return JSON.parse(stdout);
      } catch (err) {
        await removeContainer(name); // on timeout the CLI dies but the container may live on
        const { code, stderr, message } = err as {
          code?: unknown;
          stderr?: string;
          message: string;
        };
        const detail = (stderr || message).trim().slice(-STDERR_TAIL_CHARS);
        throw new Error(
          `reviewer container failed (exit ${code ?? "?"}): ${detail}`,
        );
      }
    },
  };
}

/** Fails at startup, with the fix, when the reviewer image hasn't been built. */
export async function ensureReviewerImage(cfg: ReviewerConfig): Promise<void> {
  try {
    await execFileAsync("docker", ["image", "inspect", cfg.image]);
  } catch {
    throw new Error(
      `reviewer image "${cfg.image}" not found: run \`docker compose build reviewer\``,
    );
  }
}

/**
 * Fails closed at startup: reviewers must sit on an internal network (no internet, only the gateway).
 * A typo or `bridge` here would quietly give untrusted code a way out, so the worker refuses to start.
 */
export async function ensureReviewerNetwork(
  cfg: ReviewerConfig,
): Promise<void> {
  const internal = await execFileAsync("docker", [
    "network",
    "inspect",
    "-f",
    "{{.Internal}}",
    cfg.network,
  ])
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false);
  if (!internal) {
    throw new Error(
      `reviewer network "${cfg.network}" must exist and be internal: start the stack with \`docker compose up\`, which creates it`,
    );
  }
}

const removeContainer = (name: string) =>
  execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
