# 🦦 code-otter

**Your own AI code reviewer for GitHub pull requests, running on your own machine.**

code-otter is a GitHub App. Install it on your repos, and every time someone opens a pull request it reads the changes, looks for bugs and security problems, and leaves a review: a short summary with a risk level, plus a comment right on each line that needs attention.

Think CodeRabbit, but self-hosted: your server, your LLM key, your rules.

> **Status: v0.** The full loop works: pull request → review → comments on GitHub. A few things are still on the way; see [What v0 can't do yet](#what-v0-cant-do-yet). The full design lives in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## How it works

```mermaid
flowchart LR
    PR["You open a<br/>pull request"] -->|webhook| API["api<br/>checks it really<br/>comes from GitHub"]
    API -->|queues the job| DB[("Postgres")]
    DB --> W["worker"]
    W -->|"PR code + .otter.yaml"| GH1["GitHub"]
    W -->|"1. find issues<br/>2. double-check them"| LLM["Your LLM"]
    W -->|one review with<br/>inline comments| GH2["Your pull request"]
```

In plain words:

1. **You open a pull request** (or push to one) and GitHub lets code-otter know.
2. code-otter **queues the review**. If you push several times in a row, it waits 2 minutes and only reviews the latest commit, so it doesn't waste work.
3. It **fetches the PR's code** into a local copy of the repo, works out what changed, and reads your repo's settings (`.otter.yaml`, optional). Each change comes with a bit of the code around it, up to the function it lives in, so the AI sees more than isolated lines.
4. **A first AI pass looks for problems**, focusing on bugs and security in the lines the PR adds.
5. **A second AI pass double-checks each finding** and scores it from 0 to 10. Only the ones scoring 7 or more get posted, so you get less noise.
6. **It posts one review** on your pull request. Each commit is reviewed only once.

Everything runs in Docker: an `api`, a `worker` and a `postgres` database.

---

## What you'll see on your pull request

The review starts with a summary:
- the **risk** of the PR in a coloured box: 🔴 high, 🟠 medium, 🟢 low;
- a short description of what the PR changes;
- a small table counting the findings by severity.

Then there's **one comment per finding**, attached to the exact lines, with its severity in a coloured box:

| Severity | Looks like | Meaning |
|---|---|---|
| Critical | 🔴 red | Security hole, data loss, crash on the main path |
| Major | 🟠 orange | Wrong behaviour in a realistic situation |
| Minor | 🔵 blue | Edge case or robustness issue |
| Nit | 🟢 green | Small detail, only when it's clearly worth it |

If nothing turns up, the summary says so: *no issues found, ready to merge*. It's a comment, never an approval, so a human still has the final say.

---

## Setup guide

It takes about 15 minutes. Here's the whole journey:

```mermaid
flowchart TD
    A["1. Get a webhook URL"] --> B["2. Create the GitHub App"]
    B --> C["3. Install it on your repos"]
    C --> D["4. Fill in the .env file"]
    D --> E["5. Start code-otter"]
    E --> F["6. Open a PR and watch it work 🎉"]
```

### Before you start

You'll need:
- **Docker** with Docker Compose.
- A **GitHub account**, personal or an organization, to create the App.
- An **LLM API key**: Anthropic, OpenAI, Gemini, or anything OpenAI-compatible such as [OpenRouter](https://openrouter.ai), which has free models for testing.

### Step 1 · Get a webhook URL

GitHub needs an address to tell code-otter "hey, there's a new pull request". How you get one depends on where you run it:

```mermaid
flowchart LR
    GH["GitHub"] -->|webhook| Q{"Where does<br/>code-otter run?"}
    Q -->|"On your laptop"| S["smee.io tunnel"] --> L["localhost:3000/webhook"]
    Q -->|"On a server"| P["https://your-domain/webhook"] --> V["api on port 3000"]
```

- **Trying it on your laptop:** go to https://smee.io/new and copy the URL it gives you (`https://smee.io/xxxx`). It's a free tunnel that forwards GitHub's messages to your machine. The channel never expires, so you can reuse it.
- **On a server:** use `https://your-domain/webhook`. More in [Running it on a server](#running-it-on-a-server).

Also make up a **webhook secret**, a password GitHub uses to sign its messages so nobody can impersonate it:

```bash
openssl rand -hex 32
```

Keep both values at hand for the next step.

### Step 2 · Create the GitHub App

On GitHub, go to your avatar → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
(For an organization: **Organization settings** → **Developer settings** → **GitHub Apps**.)

Fill in the form like this:

| Field | What to put |
|---|---|
| **GitHub App name** | Anything unique on GitHub, e.g. `code-otter-yourname` |
| **Homepage URL** | Any URL; this repo's link is fine |
| **Webhook → Active** | ✅ checked |
| **Webhook URL** | The URL from step 1 |
| **Webhook secret** | The secret from step 1 |
| **Repository permissions** | **Contents**: Read-only · **Pull requests**: Read and write · **Metadata**: Read-only (selected automatically) |
| **Subscribe to events** | ✅ **Pull request** |
| **Where can this GitHub App be installed?** | **Only on this account** (see [Can someone else use it?](#can-someone-else-use-it)) |

Click **Create GitHub App**. On the page that opens:

1. Write down the **App ID**, shown near the top.
2. Scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. This is the App's password, so keep it safe and never commit it.

### Step 3 · Install it on your repos

In the App's left menu: **Install App** → pick your account → **Only select repositories** → choose the repos you want reviewed.

You can add or remove repos any time from **Install App** → **Configure**, with no need to create a new App.

> 💡 **Tip:** start with a throwaway test repo. Each PR's changes are sent to your LLM provider, so try it somewhere with nothing sensitive first.

### Step 4 · Fill in the `.env` file

Copy the template:

```bash
cp .env.example .env
```

Then fill it in:

| Variable | What it is |
|---|---|
| `GITHUB_APP_ID` | The App ID from step 2 |
| `GITHUB_PRIVATE_KEY` | The contents of the `.pem` file (see below) |
| `GITHUB_WEBHOOK_SECRET` | The secret from step 1 |
| `LLM_PROVIDER` | `anthropic`, `openai` or `gemini` |
| `LLM_MODEL` | The model ID, e.g. `claude-sonnet-5-5` |
| `LLM_API_KEY` | Your provider's API key |
| `LLM_BASE_URL` | *Optional.* Only for OpenAI-compatible APIs such as OpenRouter or local models |
| `LLM_REASONING` | *Optional.* Set it to `none` if your model "thinks" for minutes before answering |
| `POSTGRES_PASSWORD` | Any password made of letters and numbers, e.g. from `openssl rand -hex 24` |

**Pasting the private key.** The `.pem` file has several lines, and you can put it in the `.env` in either of two ways:

- **As one line.** This command converts it and copies it to your clipboard (macOS; on Linux, swap `pbcopy` for `xclip -selection clipboard`):
  ```bash
  awk 'NF {sub(/\r/,""); printf "%s\\n", $0}' your-app.private-key.pem | pbcopy
  ```
  Then type `GITHUB_PRIVATE_KEY=` and paste.
- **As several lines, wrapped in double quotes:**
  ```
  GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
  MIIE...
  -----END RSA PRIVATE KEY-----"
  ```

> ⚠️ **Choose `POSTGRES_PASSWORD` before the first start.** The database takes it only when it's created. Changing it later means wiping the database with `docker compose down -v`, which deletes all its data. Don't set `DATABASE_URL` yourself: it's built from this password automatically.

#### Which LLM?

**Anthropic** (great quality, paid):
```
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
LLM_API_KEY=sk-ant-...
```

**OpenRouter free model** (perfect for trying it out at no cost):
```
LLM_PROVIDER=openai
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=nvidia/nemotron-3-super-120b-a12b:free
LLM_API_KEY=sk-or-...
LLM_REASONING=none
```

A few things to know about free models:
- The model **must support structured outputs**, because code-otter asks for answers in a fixed JSON shape. This lists the free ones that do:
  ```bash
  curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | select(.pricing.prompt == "0" and (.supported_parameters | index("structured_outputs"))) | .id'
  ```
- **Limits:** 20 requests per minute and 50 per day without credits. A small review uses about 2 requests.
- **Privacy:** some free providers keep and may use what you send them. **Don't use them with private code.**

### Step 5 · Start code-otter

If you're running it locally, open **two terminals**:

```bash
# Terminal 1: forwards GitHub's webhooks from smee to your machine
npx smee-client -u https://smee.io/xxxx -t http://localhost:3000/webhook
```

```bash
# Terminal 2: starts everything
docker compose up --build
```

You're ready when you see `api listening on :3000` and `Worker connected and looking for jobs`.

### Step 6 · Try it!

Open a pull request on a repo where the App is installed.

```mermaid
sequenceDiagram
    actor You
    participant GitHub
    participant otter as code-otter
    participant LLM
    You->>GitHub: Open a pull request
    GitHub->>otter: "New PR!" (webhook)
    otter->>GitHub: Fetch the changes and .otter.yaml
    otter->>LLM: Find bugs and security issues
    LLM-->>otter: Findings
    otter->>LLM: Double-check each finding
    LLM-->>otter: Scores from 0 to 10
    otter->>GitHub: Post one review
    GitHub-->>You: Summary + inline comments 🎉
```

- A **new PR** is reviewed right away. A **push to an open PR** waits 2 minutes, in case more pushes follow.
- Want to watch it work? `docker compose logs -f worker`
- Want it to review the same PR again? It needs a new commit, even an empty one:
  ```bash
  git commit --allow-empty -m "re-review" && git push
  ```

---

## Per-repo settings: `.otter.yaml`

Totally optional. Drop a `.otter.yaml` at the root of a repo to tune its reviews:

```yaml
# Language for the summary and comments: en (default) or es
language: en

# Files that shouldn't be reviewed (glob patterns).
# Already skipped by default: lockfiles, dist/, build/, vendor/, node_modules/,
# *.min.js, *.min.css, *.map, *.snap, *.generated.* and *.pb.go
ignore:
  - "contracts/openapi.json"
  - "src/generated/**"

# Extra guidance for the reviewer, per path (glob patterns).
# Each one is only used when the PR touches matching files.
instructions:
  - path: "src/**/domain/**"
    text: "Pure domain layer: it must not import frameworks or the infrastructure layer."
  - path: "prisma/migrations/**"
    text: "Flag destructive changes (DROP, NOT NULL without a default) that could lose data."
```

**Good to know:** code-otter reads this file from the **base branch** of the PR (usually `main`), never from the PR itself. That way a PR can't quietly turn off its own review. The flip side: a change to `.otter.yaml` only takes effect once it's merged.

If the file has a mistake, the review fails and the error shows up in the worker logs.

---

## Can someone else use it?

Yes, in two ways, and they're quite different:

```mermaid
flowchart TD
    Q{"Someone else wants<br/>code-otter on their repos"}
    Q -->|"Option 1"| A["They install YOUR App"]
    Q -->|"Option 2 (recommended)"| B["They run THEIR OWN copy"]
    A --> A1["Their PRs reach your server<br/>and use your LLM key"]
    B --> B1["Their own App, server and key:<br/>they control their code and costs"]
```

**Option 1: they install your App.** In the App settings, **Advanced** → **Make public**. It works without code changes, but keep in mind:
- their reviews run on **your** machine and are paid with **your** LLM key, with no per-user limits;
- their code goes through your server and your LLM provider;
- if your machine or tunnel is off, their PRs don't get reviewed.

Fine for a team you trust, but it's not a public service: there are no quotas, billing or isolation between users.

**Option 2: they run their own copy (recommended).** They clone this repo and follow this guide with **their own** GitHub App, LLM key and server.

Either way, one App happily handles **many repos and organizations**: each installation is handled separately.

---

## Running it on a server

Same as locally, with two differences:
- **No smee.** Point the App's **Webhook URL** at `https://your-domain/webhook`, with a reverse proxy that handles HTTPS (Caddy, nginx, Traefik…) in front of the api's port `3000`.
- **Only expose `/webhook`.** The `/admin` endpoints aren't built yet, and when they arrive they should stay on a private network.

The worker keeps a copy of each repo and a checkout of each open PR in `/var/otter` (on macOS it lives inside Docker's VM: peek with `docker compose exec worker ls /var/otter`). Make sure the server has disk for your repos. A PR's checkout is deleted when the PR is closed.

Heads-up: the worker also mounts `/var/run/docker.sock` for the sandboxed reviewer coming next. **It isn't used yet.** Access to the Docker socket is effectively root on the host, so keep that in mind on a shared server.

---

## Security and privacy

- **Each PR's changes, title and description are sent to your LLM provider.** Pick one you're comfortable sharing that code with.
- Only webhooks with a **valid GitHub signature** are accepted.
- The PR's title, description and code are treated as **untrusted**. The AI is told to ignore any instructions hidden in them, as a defence against prompt injection.
- The App asks for the **minimum permissions**: read the code and write reviews.
- Secrets live only in `.env`, and both `.env` and `*.pem` are git-ignored.

---

## What v0 can't do yet

- **No incremental reviews:** each new commit reviews the whole PR again, so earlier comments can repeat.
- **Size budget:** about 32k tokens of changes per AI call, up to 3 calls per review. Files that don't fit are listed in the summary as *not reviewed*.
- **One review at a time** per worker. Each review gets up to 3 attempts, and each AI call times out after 3 minutes.
- **Code suggestions are plain code blocks,** not GitHub's one-click *suggested changes*.
- **Rare double post:** if the worker crashes right after posting a review but before saving it, the retry posts it again.

Coming next: a sandbox with linters and repo-aware tools (v1), then incremental reviews and admin tools (v2). See [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Troubleshooting

| What you see | What's going on |
|---|---|
| A review takes minutes, or never finishes | The model is "thinking" too long. Set `LLM_REASONING=none` (or `low`). Each AI call gives up after 3 minutes and is retried |
| `401` from the LLM provider | Wrong `LLM_API_KEY`, or `LLM_BASE_URL` is missing when using OpenRouter or another OpenAI-compatible API |
| `No endpoints found matching your data policy` (OpenRouter) | In OpenRouter → **Settings** → **Privacy**, allow the providers behind free models |
| The api or worker can't connect to Postgres | `POSTGRES_PASSWORD` was changed after the database was created, or `DATABASE_URL` was set by hand. See the warning in step 4 |
| Nothing reaches the api | Is the smee client running, and is the App's **Webhook URL** right? The App's **Advanced** → **Recent Deliveries** page shows every delivery and lets you resend it |
| Webhooks arrive but nothing gets reviewed | Is the App installed on that repo, with the permissions from step 2? A commit that was already reviewed won't be reviewed again |
| `invalid .otter.yaml` in the logs | The `.otter.yaml` on the base branch has a typo or an unknown field |

---

## For developers

```bash
npm install
npm test          # builds everything (tsc -b) and runs the node:test suites
```

| Folder | What's inside |
|---|---|
| `apps/api` | Receives webhooks and queues reviews (Hono + Graphile Worker) |
| `apps/worker` | Runs the jobs: talks to GitHub, runs the review, posts it |
| `apps/reviewer` | The review engine: diff compaction, prompts, reviewer and verifier |
| `packages/contracts` | Types shared between processes |
| `db/migrations` | Database schema |

Design decisions, internals and the roadmap: [ARCHITECTURE.md](ARCHITECTURE.md).
