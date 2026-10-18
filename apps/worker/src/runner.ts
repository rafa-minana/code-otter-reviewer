import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
 * The only variables the container gets: the LLM settings, by name (Docker copies each value
 * from the worker's environment, so the key never shows up in argv or `ps`). Never the whole
 * environment: the GitHub key and the database URL must not reach it.
 * Plan 6 (gateway): LLM_BASE_URL points at the gateway and LLM_API_KEY leaves this list.
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

/** Runs the reviewer image through the Docker socket mounted in the worker. */
export function dockerRunner(cfg: ReviewerConfig): ContainerRunner {
  return {
    async runReviewer(request, worktree, name) {
      await removeContainer(name); // a leftover of a crashed attempt would clash on the name
      const run = execFileAsync("docker", dockerRunArgs(cfg, worktree, name), {
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

const removeContainer = (name: string) =>
  execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
