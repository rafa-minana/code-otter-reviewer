import { execFile } from "node:child_process";
import { glob } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  FIND_MAX_RESULTS,
  GREP_MAX_MATCHES,
  GREP_TIMEOUT_MS,
  READ_FILE_MAX_LINES,
  TOOL_LINE_MAX_CHARS,
} from "./constants.js";
import { repoFileReader } from "./files.js";

const execFileAsync = promisify(execFile);
const GREP_MAX_OUTPUT_BYTES = 1024 * 1024;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const clip = (line: string) =>
  line.length > TOOL_LINE_MAX_CHARS
    ? `${line.slice(0, TOOL_LINE_MAX_CHARS)}…`
    : line;
const capped = (lines: string[], max: number, what: string) =>
  lines.length > max
    ? [
        ...lines.slice(0, max),
        `(${lines.length - max}+ more ${what} not shown)`,
      ]
    : lines;
/** Logs which tool ran on what (never the content) to stderr: stdout carries only the output JSON. */
const log = (msg: string) => console.error(`tool ${msg}`);

/** Lines of a checkout file, numbered like the diff. Same guards as dynamic context: regular files inside the repo. */
export function readRepoFile(
  repoDir: string,
  path: string,
  startLine = 1,
  endLine?: number,
): string {
  const lines = repoFileReader(repoDir)(path);
  if (!lines)
    return `${path}: not found or not readable (only regular files up to 1 MB inside the repository)`;
  const start = Math.max(1, startLine);
  const end = Math.min(
    lines.length,
    endLine ?? lines.length,
    start + READ_FILE_MAX_LINES - 1,
  );
  if (start > lines.length) return `${path} has ${lines.length} lines`;
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}  ${clip(l)}`);
  const more =
    end < lines.length
      ? [
          `(${path} has ${lines.length} lines; read more with startLine ${end + 1})`,
        ]
      : [];
  return [...body, ...more].join("\n");
}

/** ripgrep: Rust regexes run in linear time, so a pattern from the model can't hang the review (no ReDoS). */
export async function grepRepo(
  repoDir: string,
  pattern: string,
  fileGlob?: string,
): Promise<string> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-columns",
    String(TOOL_LINE_MAX_CHARS),
    "--max-columns-preview",
    "--max-filesize",
    "1M",
    "--glob",
    "!.git",
    ...(fileGlob ? ["--glob", fileGlob] : []),
    "--regexp",
    pattern, // as a flag value, a pattern starting with "-" is never read as an option
    ".", // explicit path: with stdin a pipe, rg would search stdin instead
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("rg", args, {
      cwd: repoDir,
      timeout: GREP_TIMEOUT_MS,
      maxBuffer: GREP_MAX_OUTPUT_BYTES,
    }));
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (e.code === 1) return "no matches";
    if (e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return `grep failed: ${(e.stderr || String(err)).trim().slice(0, 500)}`;
    stdout = e.stdout ?? ""; // too many matches: the first ones are enough
  }
  const matches = stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/^\.\//, ""));
  return capped(matches, GREP_MAX_MATCHES, "matches").join("\n");
}

/** Paths matching a glob, relative to the repo. Patterns that could leave it ("..", absolute) are refused. */
export async function findRepoFiles(
  repoDir: string,
  pattern: string,
): Promise<string> {
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))
    return "the pattern must stay inside the repository";
  const root = resolve(repoDir);
  const found: string[] = [];
  const skipped = (p: string) =>
    p.split(/[\\/]/).some((part) => SKIPPED_DIRS.has(part));
  for await (const p of glob(pattern, { cwd: root, exclude: skipped })) {
    const rel = relative(root, resolve(root, p));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    found.push(rel);
    if (found.length > FIND_MAX_RESULTS) break;
  }
  return found.length
    ? capped(found, FIND_MAX_RESULTS, "paths").join("\n")
    : "no files match";
}

/** The model's only way to look outside the diff: read-only, inside the checkout, bounded output. */
export function repoTools(repoDir: string): ToolSet {
  return {
    read_file: tool({
      description: `Read lines of a repository file (at most ${READ_FILE_MAX_LINES} per call), numbered like the diff.`,
      inputSchema: z.object({
        path: z.string().describe("Path relative to the repository root"),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
      execute: async ({ path, startLine, endLine }) => {
        log(`read_file ${path}:${startLine ?? 1}-${endLine ?? ""}`);
        return readRepoFile(repoDir, path, startLine, endLine);
      },
    }),
    grep: tool({
      description: `Search the repository with a regular expression (ripgrep syntax). Returns up to ${GREP_MAX_MATCHES} "path:line:text" matches.`,
      inputSchema: z.object({
        pattern: z.string().min(1),
        glob: z
          .string()
          .optional()
          .describe(
            'Only search files matching this glob, e.g. "*.ts" or "src/**"',
          ),
      }),
      execute: async ({ pattern, glob: fileGlob }) => {
        log(
          `grep ${JSON.stringify(pattern)}${fileGlob ? ` in ${fileGlob}` : ""}`,
        );
        return grepRepo(repoDir, pattern, fileGlob);
      },
    }),
    find_files: tool({
      description: `List repository files matching a glob, e.g. "src/**/*.ts" or "**/config.*" (up to ${FIND_MAX_RESULTS}).`,
      inputSchema: z.object({ glob: z.string().min(1) }),
      execute: async ({ glob: pattern }) => {
        log(`find_files ${pattern}`);
        return findRepoFiles(repoDir, pattern);
      },
    }),
  };
}
