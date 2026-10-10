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

Separately from all of that, Apex also runs **unattended, on a nightly cron job**, and
writes repo-aware documents — whatever an admin has defined, for every repo it knows
about. Nobody asks for these and nobody waits on them; see
[Generated documents](#generated-documents) below.

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

## Generated documents

Everything above is driven by an engineer at a keyboard. Apex's other half runs with
nobody there: a **one-shot script invoked nightly by cron** (`make doc-worker`,
[docWorker.js](docWorker.js)) walks every repo Apex knows about, notices which ones have
moved since it last looked, and asks the model to write a document about each one. The
result lands on that repo's **Documents** page in the web app.

These are **repo-aware** — written from the repo's actual file tree and its key files
(`README.md`, `package.json`, `apex.pipeline.json`) read live from its default branch,
not from a template and not from anything a user typed. They are also whole-repo and
not tied to any Change Order: a document describes the repo as it stands, and is
regenerated from scratch rather than patched.

**What gets written is configured by an admin, not by an engineer and not by us.** On
`/admin/documents`, an admin creates a document definition out of four fields:

| Field | What it is |
|---|---|
| **Title** | What the document is called, on the admin page and on every repo's Documents page. |
| **Description** | Why the document exists, for whoever reads it. Never sent to the model. |
| **Model Prompt** | Sent to the model **verbatim**, as the system message. No template is wrapped around it — what an admin writes is exactly what the model receives. |
| **Model** | Which model writes it. These jobs run with no user behind them to inherit a model choice from, so a cheap document and an expensive one can use different models. |

Plus an **Active** flag: turning a document off stops it being regenerated without
deleting what has already been written.

Two things worth knowing up front:

- **Apex ships with no documents defined.** A fresh install generates nothing until an
  admin creates something — the nightly run logs `No Active Document to generate` and
  exits cleanly, which is a normal run, not a failure. To get back the
  Spec / Communication Protocol document Apex used to ship with, see
  [Recreating the Spec / Communication Protocol document](#recreating-the-spec--communication-protocol-document).
- **An admin controls what the model is *told*, not what it *reads*.** Every document,
  whatever its prompt, is written from the same material listed above. A prompt can ask
  for anything; the model still only ever sees those files.

Adding a new kind of document is a form submission. It is not a deploy, not a schema
change, and not a ticket.

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
- `docWorker.js` — generated-document regeneration and repo-file-map retirement, run
  nightly via cron. Which documents it writes comes entirely from the `doc_definitions`
  table (`app/lib/documents/docDefinitions.js`), which an admin fills in on
  `/admin/documents` (`app/routes/admin/documents.js`, `views/admin/documents.ejs`).
  **Apex ships with no document definitions**, so a fresh install generates nothing
  until someone creates one — see "Recreating the Spec / Communication Protocol
  document" below. Adding a document type is a form submission, not a deploy.
  `app/lib/documents/docContext.js` is the shared builder for what the model reads,
  which is the same material for every document.
- `db/schema.sql` — full data model, applied up front by `make setup`.
- `docs/` — setup guide, key-rotation runbook, Docker usage, and other operational docs.

## Recreating the Spec / Communication Protocol document

Until Phase 24 Apex shipped with exactly one built-in document type, written into the
code. It is now a row like any other, and it is not seeded — a fresh install generates
nothing. To get it back, go to `/admin/documents`, open the **New document** form, and
use the three values below. The form already opens with the Model Prompt pre-filled with
this exact text, so in practice this is: paste the title, paste the description, pick a
model, submit.

What this produces is not merely similar to the pre-Phase-24 document — the prompt is
sent to the model verbatim and the material it reads is unchanged, so the model receives
byte-for-byte the same two messages it received before.

**Title**

```
Spec / Communication Protocol
```

**Description** (shown to people on `/admin/documents` and on each repo's Documents
page; never sent to the model)

```
What the repo does, how it is structured, how to build and run it, and the surface
other teams integrate against. Written for engineers outside the repo.
```

**Model Prompt** (sent to the model verbatim, as the system message)

```
You are Apex's documentation agent. Write a concise Spec / Communication Protocol
document for this repo, for engineers on other teams who integrate with it but do not
work in its codebase day to day. Cover what the repo does, its overall structure, how
to build/test/run it, and its integration surface (APIs it exposes, services it
depends on, message formats) - whatever is actually evident from the material below.
Do not invent details that are not supported by it.

Respond with the complete document in Markdown, and nothing else.
```

Keep that last line, or something like it, in any document you write. Generated content
is rendered as Markdown, and it is the only thing making the model return a document
rather than a reply. Nothing validates it — a prompt without it saves fine and the
problem only shows up the next morning, on a repo's Documents page.

### Writing your own

The same form writes any other document. Beyond the scope boundary already noted above
(the model reads the same three files no matter what the prompt asks for — the first
limit you will hit writing anything that isn't an overview, see
[undecided_topics.md](undecided_topics.md)), two things are worth knowing before you
create one:

- **Editing the prompt regenerates the document for every repo** on the next nightly
  run — not immediately, and not when you edit only the title or the description
  (neither of those reaches the model, so neither can change the output).
- **The key is fixed at creation.** It is slugged from the title once; renaming the
  document afterwards does not move it. Deleting a document archives it: it stops being
  generated and disappears from every page, but the copies already written are not
  deleted and the key stays reserved, so a later document cannot inherit them.
