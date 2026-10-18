import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 10 * 60_000; // a first clone of a big repo can take minutes
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024; // diffs of large PRs

/** Where mirrors and worktrees live, and where repos are cloned from (a local path in tests). */
export interface GitEnv {
  dataDir: string;
  remoteBase: string;
}

/**
 * Runs git without a shell. The repo is untrusted: hooks are disabled, and the installation token
 * travels in env vars (never in argv, `ps` or the mirror's config). Partial clones fetch missing
 * blobs lazily, so any command that reads file contents may need the token too.
 */
export async function git(
  args: string[],
  opts: { cwd?: string; token?: string; timeoutMs?: number } = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (opts.token) {
    const basic = Buffer.from(`x-access-token:${opts.token}`).toString(
      "base64",
    );
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    });
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: opts.cwd,
        env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
    return stdout;
  } catch (err) {
    const { stderr, message } = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(stderr || message).trim()}`);
  }
}
