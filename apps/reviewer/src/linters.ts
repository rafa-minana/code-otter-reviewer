import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import { LINTER_TIMEOUT_MS, MAX_HINTS } from "./constants.js";
import { addedLines } from "./diff.js";
import type { Hint } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

/** The fields of a gitleaks JSON finding we use. */
interface GitleaksFinding {
  RuleID: string;
  Description: string;
  StartLine: number;
  File: string;
}

/** Pure: keeps the findings on lines the PR adds (an older secret isn't this PR's doing), capped. */
export function toHints(
  report: GitleaksFinding[] | null,
  repoDir: string,
  added: Set<string>,
): Hint[] {
  return (report ?? [])
    .map((f) => ({
      path: relative(repoDir, f.File),
      line: f.StartLine,
      source: "gitleaks",
      rule: f.RuleID,
      message: f.Description,
    }))
    .filter((h) => added.has(`${h.path}:${h.line}`))
    .slice(0, MAX_HINTS);
}

/**
 * Leaked secrets in the checkout, as hints for the model. --redact keeps the secret out of the prompt.
 * Any failure (missing binary, timeout, bad output) is logged and leaves the review without hints.
 * shortcut: the repo's .gitleaks.toml/.gitleaksignore are honoured, so a PR could allowlist its own secret;
 * read them from the base branch if that gets abused.
 */
export async function runLinters(
  repoDir: string,
  diff: string,
): Promise<Hint[]> {
  try {
    const { stdout } = await execFileAsync(
      "gitleaks",
      [
        "dir",
        repoDir,
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--redact",
        "--no-banner",
        "--exit-code",
        "0",
        "--max-target-megabytes",
        "1",
        "--log-level",
        "error",
      ],
      { cwd: repoDir, timeout: LINTER_TIMEOUT_MS, maxBuffer: MAX_REPORT_BYTES },
    );
    return toHints(JSON.parse(stdout), repoDir, addedLines(diff));
  } catch (err) {
    console.error(
      `gitleaks skipped: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}
