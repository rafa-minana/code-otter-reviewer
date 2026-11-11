import { assertGatewaySecret } from "@otter/gateway/token.js";
import type { GitEnv } from "./git/run.js";

/** Mirrors and worktrees: the mount point of the data volume, whose subpaths the launcher mounts into reviewers. */
const DEFAULT_DATA_DIR = "/var/otter";
const GITHUB_URL = "https://github.com";
/** The only service with the Docker socket, on a network shared with the worker alone. */
const DEFAULT_LAUNCHER_URL = "http://otter-launcher:8090";
/** The gateway's alias on the reviewers' internal network; the reviewer's LLM_BASE_URL. */
const DEFAULT_GATEWAY_URL = "http://otter-gateway:8080";
/** Simultaneous jobs; each review runs one reviewer container (up to 1 GB RAM, 1 CPU). */
const DEFAULT_CONCURRENCY = 1;
/** Quota for mirrors + worktrees; a review is aborted when it's reached. */
const DEFAULT_MAX_STORAGE_GB = 10;
/** The janitor removes a repo (mirror included) after this many days without a webhook. */
const DEFAULT_REPO_IDLE_DAYS = 30;
const GB = 1024 ** 3;

export interface ReviewerConfig {
  launcherUrl: string;
  gatewayUrl: string;
  /** Signs each review's token; shared with the gateway, never passed to the container. */
  gatewaySecret: string;
}

export interface Config {
  databaseUrl: string;
  git: GitEnv;
  reviewer: ReviewerConfig;
  concurrency: number;
  maxStorageBytes: number;
  repoIdleDays: number;
  appId: string;
  privateKey: string;
}

/** The LLM settings are validated separately by createLlm(env). */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const { DATABASE_URL, GITHUB_APP_ID, GITHUB_PRIVATE_KEY } = env;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!GITHUB_APP_ID) throw new Error("GITHUB_APP_ID is required");
  if (!GITHUB_PRIVATE_KEY) throw new Error("GITHUB_PRIVATE_KEY is required");
  return {
    databaseUrl: DATABASE_URL,
    git: {
      dataDir: env.OTTER_DATA_DIR || DEFAULT_DATA_DIR,
      remoteBase: GITHUB_URL,
    },
    reviewer: {
      launcherUrl: env.REVIEWER_LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
      gatewayUrl: env.REVIEWER_GATEWAY_URL || DEFAULT_GATEWAY_URL,
      gatewaySecret: assertGatewaySecret(env.GATEWAY_SECRET),
    },
    concurrency: positiveInt(
      "WORKER_CONCURRENCY",
      env.WORKER_CONCURRENCY,
      DEFAULT_CONCURRENCY,
    ),
    maxStorageBytes:
      positiveNumber(
        "MAX_SPACE_REPO_STORAGE_GB",
        env.MAX_SPACE_REPO_STORAGE_GB,
        DEFAULT_MAX_STORAGE_GB,
      ) * GB,
    repoIdleDays: positiveInt(
      "KEEP_REPO_IDLE_DAYS",
      env.KEEP_REPO_IDLE_DAYS,
      DEFAULT_REPO_IDLE_DAYS,
    ),
    appId: GITHUB_APP_ID,
    // .env files can't hold multi-line values everywhere, so accept "\n"-escaped PEMs
    privateKey: GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}

function positiveInt(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const n = positiveNumber(name, value, fallback);
  if (!Number.isInteger(n))
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

function positiveNumber(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!(n > 0))
    throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}
