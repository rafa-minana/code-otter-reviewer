import type { GitEnv } from "./git/run.js";

/** Mirrors and worktrees. Same path on the host and in the worker: reviewer containers (v1) are siblings. */
const DEFAULT_DATA_DIR = "/var/otter";
const GITHUB_URL = "https://github.com";

export interface Config {
  databaseUrl: string;
  git: GitEnv;
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
    appId: GITHUB_APP_ID,
    // .env files can't hold multi-line values everywhere, so accept "\n"-escaped PEMs
    privateKey: GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}
