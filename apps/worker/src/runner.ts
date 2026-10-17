import type { ContainerRunner } from "./ports.js";

/** docker run --rm of the reviewer image. */
export const dockerRunner: ContainerRunner = {
  async runReviewer(job, worktree, input) {
    throw new Error("not implemented");
  },
};
