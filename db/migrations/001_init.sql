-- graphile_worker.* is created by the library itself.

CREATE TABLE repos (
  id           bigserial PRIMARY KEY,
  owner        text NOT NULL,
  name         text NOT NULL,
  installation_id bigint NOT NULL,
  mirror_path  text,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

CREATE TABLE pull_requests (
  id                bigserial PRIMARY KEY,
  repo_id           bigint NOT NULL REFERENCES repos ON DELETE CASCADE,
  number            integer NOT NULL,
  state             text NOT NULL DEFAULT 'open',
  last_reviewed_sha text,
  expires_at        timestamptz,
  UNIQUE (repo_id, number)
);

CREATE TABLE reviews (
  id               bigserial PRIMARY KEY,
  pull_request_id  bigint NOT NULL REFERENCES pull_requests ON DELETE CASCADE,
  sha              text NOT NULL,
  -- State machine in packages/contracts/src/review-status.ts
  status           text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'published', 'stale', 'failed', 'cancelled')),
  error            text,   -- why it failed
  job_id           bigint, -- Graphile job that claimed it; only that job's retries reclaim it
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  github_review_id bigint
);

-- Each (PR, SHA) is reviewed once; a re-review cancels the old row, which stays as history.
CREATE UNIQUE INDEX reviews_one_per_sha ON reviews (pull_request_id, sha) WHERE status <> 'cancelled';

CREATE TABLE findings (
  id         bigserial PRIMARY KEY,
  review_id  bigint NOT NULL REFERENCES reviews ON DELETE CASCADE,
  path       text NOT NULL,
  line       integer NOT NULL,
  side       text NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
  severity   text NOT NULL,
  body       text NOT NULL,
  published  boolean NOT NULL DEFAULT false
);
