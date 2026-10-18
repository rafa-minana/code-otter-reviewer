import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ReadLines } from "./diff.js";

/** Bigger files are left without extra context: not worth the read, and likely generated. */
const MAX_FILE_BYTES = 1_000_000;

/** Not a symlink, a directory or a device, and small enough to read. */
const isSmallRegularFile = (path: string) => {
  const stat = lstatSync(path);
  return stat.isFile() && stat.size <= MAX_FILE_BYTES;
};

/** Its real path stays inside root (a symlinked parent directory could point anywhere). */
const isInside = (root: string, path: string) => {
  const rel = relative(root, realpathSync(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
};

const toLines = (text: string) => {
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
};

/**
 * Reads files of the PR's checkout for dynamic context. The checkout is untrusted: a symlink
 * pointing outside it would leak host files to the LLM, so only regular files inside it are read.
 * Anything missing or unreadable returns null, and its hunks keep git's own context.
 */
export function repoFileReader(repoDir: string): ReadLines {
  const root = realpathSync(repoDir);
  return (path) => {
    const full = join(root, path);
    try {
      return isSmallRegularFile(full) && isInside(root, full) ? toLines(readFileSync(full, "utf8")) : null;
    } catch {
      return null;
    }
  };
}
