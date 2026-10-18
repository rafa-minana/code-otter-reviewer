import type { GitEnv } from "./git/run.js";

/** Mirrors and worktrees. Same path on the host and in the worker: reviewer containers (v1) are siblings. */
const DEFAULT_DATA_DIR = "/var/otter";
const GITHUB_URL = "https://github.com";
/** Built by `docker compose build reviewer`; never pulled from a registry. */
const DEFAULT_REVIEWER_IMAGE = "code-otter-reviewer";
/** Docker's default network (internet access). Plan 6 swaps it for an internal one with the LLM gateway. */
const DEFAULT_REVIEWER_NETWORK = "bridge";

export interface ReviewerConfig {
  image: string;
  network: string;
}

export interface Config {
  databaseUrl: string;
  git: GitEnv;
  reviewer: ReviewerConfig;
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
    },
    appId: GITHUB_APP_ID,
    // .env files can't hold multi-line values everywhere, so accept "\n"-escaped PEMs
    privateKey: GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}
