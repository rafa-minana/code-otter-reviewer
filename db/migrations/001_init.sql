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
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  result           text,
  github_review_id bigint,
  UNIQUE (pull_request_id, sha) -- each (PR, SHA) is reviewed once
);

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
