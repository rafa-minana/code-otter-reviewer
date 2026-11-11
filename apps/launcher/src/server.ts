import { createServer, type Server, type ServerResponse } from "node:http";
import {
  REVIEWER_LLM_ENV,
  type LaunchRequest,
  type LaunchResult,
  type ReviewerRequest,
} from "@otter/contracts";
import { MAX_OUTPUT_BYTES, type LauncherConfig } from "./docker.js";

export const PORT = 8090;
const MAX_REQUEST_BYTES = MAX_OUTPUT_BYTES;

/** The layout of apps/worker/src/git/worktree.ts. No `,` can get in: it would add options to `--mount`. */
const WORKTREE = /^worktrees\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pr\d+\/[0-9a-f]{40,64}$/;
const REVIEW_ID = /^\d{1,20}$/; // the reviews row id, as the gateway token also requires

export type Run = (
  cfg: LauncherConfig,
  job: LaunchRequest,
  signal: AbortSignal,
) => Promise<LaunchResult>;

/**
 * The caller may be a compromised worker: every field is checked, and the request decides nothing
 * about the container but which worktree it reads and its LLM variables. Undefined if anything is off.
 */
export function parseLaunchRequest(body: unknown): LaunchRequest | undefined {
  const { reviewId, worktree, env, request } = (body ?? {}) as Record<string, unknown>;
  if (typeof reviewId !== "string" || !REVIEW_ID.test(reviewId)) return;
  if (typeof worktree !== "string" || !WORKTREE.test(worktree)) return;
  if (worktree.split("/").some((s) => s === "." || s === "..")) return;
  if (typeof env !== "object" || env === null || typeof request !== "object" || request === null) return;
  const llmEnv: LaunchRequest["env"] = {};
  for (const name of REVIEWER_LLM_ENV) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string" && !value.includes("\0")) llmEnv[name] = value; // anything else is dropped
  }
  return { reviewId, worktree, env: llmEnv, request: request as ReviewerRequest };
}

/** POST /review runs one review container and answers with its LaunchResult; GET /healthz for compose. */
export function createLauncher(cfg: LauncherConfig, run: Run): Server {
  let running = 0;
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/review") return send(res, 404, { error: "not found" });
    if (running >= cfg.maxReviewers) return send(res, 429, { error: "too many reviews at once" });
    running++;
    try {
      const job = parseLaunchRequest(await readJson(req));
      if (!job) return send(res, 400, { error: "invalid request" });
      const abort = new AbortController();
      // the worker hung up (restart, crash): stop its container instead of reviewing for nobody
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      send(res, 200, await run(cfg, job, abort.signal));
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    } finally {
      running--;
    }
  });
}

/** The parsed body, or undefined if it isn't JSON or is too big. */
async function readJson(req: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
