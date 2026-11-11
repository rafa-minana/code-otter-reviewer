import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  REVIEW_CONTAINER_TIMEOUT_MS,
  REVIEWER_LLM_ENV,
  type LaunchRequest,
  type LaunchResult,
} from "@otter/contracts";

const execFileAsync = promisify(execFile);

/** Every reviewer container is named `otter-review-<review id>`; only the launcher creates them. */
const CONTAINER_PREFIX = "otter-review-";
/** Mount point of the PR's checkout inside the container (read-only). */
const REPO_MOUNT = "/repo";
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** `--mount ...,volume-subpath=` needs Docker Engine 26, i.e. API 1.45. */
export function supportsVolumeSubpath(apiVersion: string): boolean {
  const [major = 0, minor = 0] = apiVersion.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 45);
}

export interface LauncherConfig {
  image: string;
  network: string;
  /** The named volume holding mirrors and worktrees (the worker's /var/otter). */
  volume: string;
  /** Reviewer containers at once; more get a 429. */
  maxReviewers: number;
}

/**
 * `docker run` for one review: no privileges, read-only filesystem, the checkout read-only, bounded resources.
 * The checkout is a subpath of the data volume, not a host path: Docker resolves it inside the volume, so
 * a symlink planted by a compromised worker can't mount anything else of the host.
 */
export function dockerRunArgs(
  cfg: LauncherConfig,
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
    // by name: Docker copies each value from the CLI's environment, so none shows up in argv or `ps`
    ...REVIEWER_LLM_ENV.flatMap((v) => ["-e", v]),
    "--mount",
    `type=volume,src=${cfg.volume},dst=${REPO_MOUNT},volume-subpath=${worktree},readonly`,
    cfg.image,
  ];
}

/** Runs one review container to the end; `signal` aborts it (the worker hung up). Never throws. */
export async function runReviewer(
  cfg: LauncherConfig,
  job: LaunchRequest,
  signal: AbortSignal,
): Promise<LaunchResult> {
  const name = `${CONTAINER_PREFIX}${job.reviewId}`;
  await removeContainer(name); // a leftover of a crashed attempt would clash on the name
  const run = execFileAsync("docker", dockerRunArgs(cfg, job.worktree, name), {
    env: { ...process.env, ...job.env }, // the launcher's own env holds no secrets (compose gives it four names)
    timeout: REVIEW_CONTAINER_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    signal,
  });
  run.child.stdin?.end(JSON.stringify(job.request));
  try {
    const { stdout, stderr } = await run;
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    await removeContainer(name); // on timeout or abort the CLI dies but the container may live on
    const { code, stdout, stderr, message } = err as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      exitCode: typeof code === "number" ? code : null, // `docker run` passes the container's exit code through
      stdout: stdout ?? "",
      stderr: stderr || message,
    };
  }
}

const removeContainer = (name: string) =>
  execFileAsync("docker", ["rm", "-f", name]).catch(() => {});

/** Fails at startup, with the fix, when something reviews depend on is missing. */
export async function ensureDocker(cfg: LauncherConfig): Promise<void> {
  const api = await docker(["version", "-f", "{{.Server.APIVersion}}"]);
  if (!api || !supportsVolumeSubpath(api))
    throw new Error(`Docker Engine 26+ is required (volume-subpath mounts); the daemon speaks API ${api ?? "?"}`);
  if ((await docker(["image", "inspect", "-f", "ok", cfg.image])) === undefined)
    throw new Error(`reviewer image "${cfg.image}" not found: run \`docker compose build reviewer\``);
  if ((await docker(["volume", "inspect", "-f", "ok", cfg.volume])) === undefined)
    throw new Error(`data volume "${cfg.volume}" not found: start the stack with \`docker compose up\`, which creates it`);
  // Fails closed: a typo or `bridge` here would quietly give untrusted code a way out.
  if ((await docker(["network", "inspect", "-f", "{{.Internal}}", cfg.network])) !== "true")
    throw new Error(
      `reviewer network "${cfg.network}" must exist and be internal: start the stack with \`docker compose up\`, which creates it`,
    );
}

/**
 * At startup no review is this launcher's yet: a reviewer container still around belongs to a launcher
 * that died with it running (a restart), and nobody will read its answer. It would keep spending LLM budget.
 */
export async function removeOrphanReviewers(): Promise<void> {
  const ids = (await docker(["ps", "-aq", "--filter", `name=^${CONTAINER_PREFIX}`]))?.split("\n").filter(Boolean) ?? [];
  if (ids.length) await docker(["rm", "-f", ...ids]);
}

/** A docker CLI call's trimmed stdout, or undefined if it failed. */
const docker = (args: string[]) =>
  execFileAsync("docker", args).then(
    ({ stdout }) => stdout.trim(),
    () => undefined,
  );
