import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DU_TIMEOUT_MS = 60_000;
const GB = 1024 ** 3;

/** Repo storage (mirrors + worktrees) is over MAX_SPACE_REPO_STORAGE_GB. */
export class DiskFullError extends Error {}

/** Bytes used under `dir` (`du -sk`: busybox in the image); 0 before the first clone. */
export async function usedBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const { stdout } = await execFileAsync("du", ["-sk", dir], {
    timeout: DU_TIMEOUT_MS,
  });
  return Number(stdout.split(/\s/)[0]) * 1024;
}

/** Throws DiskFullError when the repo storage has reached its quota. */
export async function assertStorage(
  dir: string,
  maxBytes: number,
): Promise<void> {
  const used = await usedBytes(dir);
  if (used >= maxBytes)
    throw new DiskFullError(
      `repo storage full: ${(used / GB).toFixed(2)} GB used of ${(maxBytes / GB).toFixed(2)} GB (MAX_SPACE_REPO_STORAGE_GB) in ${dir}`,
    );
}

/** Over the quota, or the disk itself ran out (git's "No space left on device", Node's ENOSPC). */
export const isDiskFull = (err: unknown): boolean =>
  err instanceof DiskFullError ||
  /ENOSPC|No space left on device/.test((err as Error)?.message ?? "");
