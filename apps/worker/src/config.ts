import { assertGatewaySecret } from "@otter/gateway/token.js";
import type { GitEnv } from "./git/run.js";

/** Mirrors and worktrees. Same path on the host and in the worker: reviewer containers (v1) are siblings. */
const DEFAULT_DATA_DIR = "/var/otter";
const GITHUB_URL = "https://github.com";
/** Built by `docker compose build reviewer`; never pulled from a registry. */
const DEFAULT_REVIEWER_IMAGE = "code-otter-reviewer";
/** Internal network created by docker compose: no internet, only the LLM gateway (ARCHITECTURE.md §5). */
const DEFAULT_REVIEWER_NETWORK = "otter-reviewers";
/** The gateway's alias on that network; the reviewer's LLM_BASE_URL. */
const DEFAULT_GATEWAY_URL = "http://otter-gateway:8080";
/** Simultaneous jobs; each review runs one reviewer container (up to 1 GB RAM, 1 CPU). */
const DEFAULT_CONCURRENCY = 1;

export interface ReviewerConfig {
  image: string;
  network: string;
  gatewayUrl: string;
  /** Signs each review's token; shared with the gateway, never passed to the container. */
  gatewaySecret: string;
}

export interface Config {
  databaseUrl: string;
  git: GitEnv;
  reviewer: ReviewerConfig;
  concurrency: number;
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
      image: env.REVIEWER_IMAGE || DEFAULT_REVIEWER_IMAGE,
      network: env.REVIEWER_NETWORK || DEFAULT_REVIEWER_NETWORK,
      gatewayUrl: env.REVIEWER_GATEWAY_URL || DEFAULT_GATEWAY_URL,
      gatewaySecret: assertGatewaySecret(env.GATEWAY_SECRET),
    },
    concurrency: parseConcurrency(env.WORKER_CONCURRENCY),
    appId: GITHUB_APP_ID,
    // .env files can't hold multi-line values everywhere, so accept "\n"-escaped PEMs
    privateKey: GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}

function parseConcurrency(value: string | undefined): number {
  if (!value) return DEFAULT_CONCURRENCY;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      `WORKER_CONCURRENCY must be a positive integer, got "${value}"`,
    );
  return n;
}
