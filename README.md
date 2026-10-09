# Apex

Apex is an internal tool that turns a Change Order (CO) into real, working code — on a
dedicated development branch, ready for human review.

An engineer picks a repository and branch, describes the change, and clarifies it with
an AI assistant that asks grounded, repo-aware questions before anything is written.
Once the requirements are confirmed and the engineer explicitly approves, Apex
implements the change in an isolated, network-sealed sandbox, builds it, runs its
tests, and — only if everything passes — pushes the result to a `dev/**` branch.

**Apex stops there.** It never opens a pull request and never merges. Code review,
promotion to a test branch, and the merge to `main` remain exactly the human-driven
process they were before Apex existed — Apex's job is to get an engineer to a working
DEV branch faster, not to make the final call.

## How it works, in short

1. **Pick a repo and branch.** Start fresh off the repo's default branch, or continue
   an existing one — Apex tracks everything by `(repo, Change Order)`.
2. **Clarify.** Describe what you need; the AI asks questions grounded in the actual
   codebase (it reads file contents on demand, not generically) until the requirement
   is unambiguous. If it looks like the request overlaps work already done on this
   branch, Apex flags it — a human always confirms or overrides, nothing is ever
   silently skipped.
3. **Approve.** Nothing runs until you explicitly approve. Adding a new requirement
   after approval (but before it starts) automatically asks for re-approval — scope
   never silently expands.
4. **Implement, in isolation.** A throwaway, network-sealed container clones the repo,
   writes the code, builds it, and tests it. If a step fails, the container is kept
   alive so the run can resume from where it died instead of starting over.

   Edits are **targeted, not wholesale rewrites**: the AI navigates a large file by its
   outline, reads the handful of regions it needs, and replaces specific line ranges —
   restating the exact text it expects to find there first, so an edit that would land
   in the wrong place is refused rather than applied. It never rewrites a file it hasn't
   read in full.
5. **Push to DEV.** Only a passing build/test result ever gets pushed, and only to a
   `dev/**` branch — a GitHub App scoped to exactly that, with no merge authority at
   all.

## Documentation

| Document | For |
|---|---|
| [SPEC.md](SPEC.md) | Engineers who want to understand the architecture, data model, and full lifecycle under the hood. |
| [apex_nim_integration.md](apex_nim_integration.md) | How Apex talks to its LLM backend, and exactly how it decides what repo content to send on each call. |
| [apex_troubleshooting.md](apex_troubleshooting.md) | Diagnosing a stuck session, a failed pipeline, a model error, or other operational issues. |
| [ROADMAP.md](ROADMAP.md) | The full build plan, design decisions, and accepted risks behind the current system. |
| [undecided_topics.md](undecided_topics.md) | What's genuinely still open or unbuilt. |
| [docs/](docs) | Setup, Docker architecture, GitHub App key rotation, and the reasoning behind Apex's human-approval gates. |


### Download:
```txt
curl -fsSL https://raw.githubusercontent.com/yparsak/Apex/main/scripts/download.sh -o /tmp/download.sh
bash /tmp/download.sh
```

```
cd ~/src/Apex
cp .env.example .env
```

Modify .env

## Setup
```
make setup
make create-admin ARGS='--username=admin --password=adminpassword --initials=AA --admin'
```

Then, in separate terminals:

```
make dev              # web app -> http://localhost:3000/login
make worker           # AI pipeline worker - required for sessions to actually run
make doc-worker       # optional, one-shot doc-regen run - meant to be cron-scheduled nightly
```

See [docs/Phase1_setup.md](docs/Phase1_setup.md) for what each step does and
troubleshooting for first-time setup, or [apex_troubleshooting.md](apex_troubleshooting.md)
for issues after setup succeeds.

### Stopping everything

```
make stop       # removes apex-app, apex-worker
make db-down    # also stops apex-mariadb (keeps the data volume)
make clean      # full reset - also removes the data volume and network
```

(Substitute `podman` for `docker` anywhere above with `RUNTIME=podman`.)

## Project structure

- `app/` — Express routes, views (EJS), and `lib/` service modules.
  - `lib/repoContext.js` / `lib/repoMap.js` / `lib/structuralIndex.js` — the one place
    repo content reaches the model: shared read caps, the line model, and the
    truncation-announcing file and range reads, over a cached, size-aware map of each
    commit's files plus a per-file outline built from the sandbox's own clone.
  - `lib/pipeline/rangedWrite.js` — the anchored-write protocol: parse a line-range
    edit, verify its anchor against the file, splice or refuse.
- `worker.js` — AI pipeline poller (see [SPEC.md](SPEC.md)).
- `docWorker.js` — Spec/Communication Protocol doc regeneration and repo-file-map
  retirement, run nightly via cron.
- `db/schema.sql` — full data model, applied up front by `make setup`.
- `docs/` — setup guide, key-rotation runbook, Docker usage, and other operational docs.
