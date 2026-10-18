import { extname, matchesGlob } from "node:path";
import { DEFAULT_IGNORE } from "./constants.js";
import type { Chunk, ChunkedDiff, FileDiff, Hunk } from "./types.js";

// Diff compaction (ARCHITECTURE.md §5), simplified from PR-Agent's pr_processing.py.

/** shortcut: chars / 4 instead of a real tokenizer; switch if we overshoot the model's limit. */
export const countTokens = (s: string) => Math.ceil(s.length / 4);

// Hunk lines always start with " ", "+" or "-", so "diff --git " and "@@ " at line start are safe split points.
export const parseDiff = (diff: string): FileDiff[] =>
  diff
    .split(/^(?=diff --git )/m)
    .filter((block) => block.startsWith("diff --git "))
    .map(parseFile);

function parseFile(block: string): FileDiff {
  const [head, ...hunks] = block.split(/^(?=@@ )/m);
  return {
    // +++ is more reliable than the diff --git line when paths contain " b/"; deleted and binary files lack it
    path:
      /^\+\+\+ b\/(.+)$/m.exec(head)?.[1] ??
      /^diff --git a\/.+ b\/(.+)$/m.exec(head)![1],
    deleted: /^deleted file mode/m.test(head),
    binary: /^Binary files/m.test(head),
    hunks: hunks.map(parseHunk),
  };
}

function parseHunk(text: string): Hunk {
  const [header, ...lines] = text.split("\n");
  return {
    header,
    newStart: Number(/^@@ -\S+ \+(\d+)/.exec(header)?.[1] ?? 1),
    lines: lines.filter((l) => /^[ +-]/.test(l)), // drops "\ No newline at end of file"
  };
}

/** PR-Agent format: only the new side is numbered, since that is where comments go. */
function renderFile(f: FileDiff): string {
  const out = [`## File: '${f.path}'`];
  for (const h of f.hunks) {
    out.push("", h.header, "__new hunk__");
    let n = h.newStart;
    for (const l of h.lines) if (l[0] !== "-") out.push(`${n++} ${l}`);
    if (h.lines.some((l) => l[0] === "-")) {
      out.push("__old hunk__");
      for (const l of h.lines) if (l[0] !== "+") out.push(l);
    }
  }
  return out.join("\n");
}

const toChunk = (files: FileDiff[]): Chunk => ({
  text: files.map(renderFile).join("\n\n"),
  paths: files.map((f) => f.path),
});

const changeSize = (f: FileDiff) =>
  f.hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] !== " ").length, 0);

export function chunkDiff(
  diff: string,
  opts: { maxTokens: number; maxCalls: number; ignore: string[] },
): ChunkedDiff {
  const globs = [...DEFAULT_IGNORE, ...opts.ignore];
  const files = parseDiff(diff);
  const isFiltered = (f: FileDiff) =>
    f.binary || globs.some((g) => matchesGlob(f.path, g));
  const filtered = files.filter(isFiltered).map((f) => f.path);
  const kept = files.filter((f) => !isFiltered(f));
  const deleted = kept.filter((f) => f.deleted).map((f) => f.path);
  const live = kept.filter((f) => !f.deleted && f.hunks.length);

  const whole = toChunk(live);
  if (countTokens(whole.text) <= opts.maxTokens) {
    return {
      chunks: live.length ? [whole] : [],
      filtered,
      deleted,
      notReviewed: [],
    };
  }

  // Doesn't fit: drop delete-only hunks, main language first, biggest changes first, never split a file.
  const compacted = live
    .map((f) => ({
      ...f,
      hunks: f.hunks.filter((h) => h.lines.some((l) => l[0] === "+")),
    }))
    .filter((f) => f.hunks.length);
  const extCount = new Map<string, number>();
  for (const f of compacted)
    extCount.set(extname(f.path), (extCount.get(extname(f.path)) ?? 0) + 1);
  const main = [...extCount].sort((a, b) => b[1] - a[1])[0]?.[0];
  compacted.sort(
    (a, b) =>
      Number(extname(b.path) === main) - Number(extname(a.path) === main) ||
      changeSize(b) - changeSize(a),
  );

  // Fill the current chunk; when full, open another while calls remain; otherwise leave the file out.
  const groups: { files: FileDiff[]; tokens: number }[] = [];
  const notReviewed: string[] = [];
  for (const f of compacted) {
    const tokens = countTokens(renderFile(f)) + 1;
    const current = groups.at(-1);
    const fitsInCurrent =
      current !== undefined && current.tokens + tokens <= opts.maxTokens;
    const canOpenChunk =
      tokens <= opts.maxTokens && groups.length < opts.maxCalls;

    if (fitsInCurrent) {
      current.files.push(f);
      current.tokens += tokens;
    } else if (canOpenChunk) groups.push({ files: [f], tokens });
    else notReviewed.push(f.path);
  }
  return {
    chunks: groups.map((g) => toChunk(g.files)),
    filtered,
    deleted,
    notReviewed,
  };
}
