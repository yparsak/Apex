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

### One session at a time per Change Order — and the holder can hand it back

Only one AI session can be in flight per `(repo, Change Order)`, across every user. The
branch page tells you which side of that you are on, and when you are the holder it gives
you a way out: **Release pipeline lock** frees the slot for everyone else on the repo.

It is not the same button as "Clear & start new session" on a failed run. Clear is for
carrying on — it hands you a fresh session and you still hold the slot. Release is for
abandoning: a draft whose requirements you no longer want, a session left waiting for
approval over a weekend. Afterwards you hold nothing, and nothing is reserved for you — if
a colleague starts on that CO first, you wait like anyone else. The session itself stays
exactly as it was and stays readable; only the slot moves.

The one time it is refused is while the run is actually executing, because the worker is
mid-pipeline and freeing the slot under it is the collision the lock exists to prevent.
An admin force-unlock still exists for the case the holder genuinely cannot act — but it
is no longer the only way a forgotten slot ever comes free.

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

`/admin/documents` itself is a list — one row per document, showing its key, whether it
is on, which model actually writes it (flagged when that is a fallback rather than the
configured choice) and how many repos have a copy. The prompt is not on the list: titles
link to a page per document where the four fields and everything the system has to say
about them live together, and **New document** opens the same form with the prompt
prefilled.

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

### Running a document against a branch, before the merge

The nightly run reads the default branch, which makes every document a **post-merge**
artifact: an admin writes a "Coding Practices" definition, an engineer opens a pull
request, and the first time that prompt sees the new code is the night after it has
already landed. The report still catches the problem — one merge too late.

So any active document can also be run **on demand against a branch**, from that
branch's page: pick a document, click **Run against this branch**, wait about a minute,
read the report. Nothing about authorship changes — the admin still owns the title,
prompt and model, and a user picks only a branch and a document.

Two things make it worth doing, and one thing is worth being clear about:

- **The branch run also reads the diff.** On a feature branch the three key files above
  are almost always byte-identical to trunk's, so a report written from those alone
  would just repeat what the nightly one said. The run adds the **full contents** of
  every file the branch changes — not the patches, which are too little context to judge
  a function by. Large changes are capped (40 files / 120,000 characters) and whatever
  is left out is named in the prompt, so the model says what it did not see rather than
  presenting a partial review as complete.
- **The report is not saved.** It is generated while you wait, shown once, and gone on
  refresh — download it with the button on the page if you want to keep it. Nothing is
  written to the repo's Documents page, and the next nightly run behaves exactly as if
  the run never happened. The artifact of record is still the nightly document.
- **Per repo, an admin can turn this off** on `/admin/repos` ("On-demand runs"), for a
  repo whose branch diffs are too large to review usefully or whose model spend needs
  containing. Turning it off does **not** stop that repo's nightly documents, which keep
  arriving either way.

## Freezing a repo without hiding it

A repo that should stop accepting work needs somewhere to go that is not deletion. On
`/admin/repos` every repo has a three-position **State**, and each step down removes
exactly one capability:

| | read the repo | generate documents | create branches & run pipelines |
|---|---|---|---|
| **Enabled** | ✓ | ✓ | ✓ |
| **Read-only** — documents still update | ✓ | ✓ | ✗ |
| **Disabled** — view only, documents frozen | ✓ | ✗ | ✗ |

**Every repo stays visible in all three states, to everyone with access to its group.**
Reading is never what gets removed — a frozen repo is still a repo you can open, browse
and search, which is the point of freezing it rather than deleting it.

- **Read-only** is for a repo Apex should keep *describing* but stop *changing*. Its
  documents stay current: the nightly run still regenerates them and engineers can still
  run one against a branch. Nothing new may be started — no branch created or adopted, no
  pipeline approved, retried or resumed, no branch deactivated or deleted.
- **Disabled** is for a repo that is dormant. Nothing is generated, so its documents stay
  frozen at the commit they were last written from, and the repo costs no GitHub calls and
  no model spend overnight. Everything already written stays readable — **and says it is
  frozen**, on each document and on the cross-repo search, naming the commit it came from.

Each state carries a **note** — free text, shown to engineers on the repo's own pages and
quoted in every refusal. It is the answer to "why can't I create a branch here", and the
useful ones ("frozen until the Q1 audit closes, ask Dana") are the kind no dropdown
predicts.

Two things worth knowing:

- **Approved work is paused, not lost.** A run already queued when a repo leaves Enabled
  stays queued and simply does not start; setting the repo back to Enabled resumes it
  where it sat, with no re-approval. `/admin/repos` shows the count on the row so that
  paused work is not invisible. A pipeline that was already *running* finishes — killing
  it mid-flight would leave a half-pushed branch behind.
- **Admins get no bypass.** The state describes the repo, not the viewer, so an admin sees
  exactly what an engineer sees. Managing the state is what `/admin/repos` is for.

### Disabled is how a repo is retired. Delete is not.

`/admin/repos` also has a Delete button, and the two are not alternatives. Delete removes
the repo row itself, and only succeeds on a repo nothing references — one added by mistake
and never used. As soon as a repo has change orders, branches, runs or documents, deleting
it would destroy the record those tables exist to keep, so it is refused, and **the refusal
says how much history is in the way** ("12 change orders, 1 branch, 34 pipeline runs") and
points at Disabled. There is no cascading delete and none is planned: an audit trail that
can be erased from a web form is not an audit trail.

So the two controls are kept visually apart on the row, and a Disabled repo sorts to the
bottom of the list and greys out — retired, still readable, out of the way.

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
  `/admin/documents` (`app/routes/admin/documents.js`, with `views/admin/documents.ejs`
  as the list and `views/admin/document-form.ejs` as the create/edit form).
  **Apex ships with no document definitions**, so a fresh install generates nothing
  until someone creates one — see "Recreating the Spec / Communication Protocol
  document" below. Adding a document type is a form submission, not a deploy.
  `app/lib/documents/docContext.js` is the shared builder for what the model reads,
  which is the same material for every document — plus, for an on-demand branch run
  only, the contents of what that branch changes. Those runs do not go through this
  worker at all: `app/lib/documents/docRunService.js` runs them inside the web request
  that asked for one, and stores nothing.
- `db/schema.sql` — full data model, applied up front by `make setup`.
- `docs/` — setup guide, key-rotation runbook, Docker usage, and other operational docs.

## Recreating the Spec / Communication Protocol document

Until Phase 24 Apex shipped with exactly one built-in document type, written into the
code. It is now a row like any other, and it is not seeded — a fresh install generates
nothing. To get it back, go to `/admin/documents`, follow **New document**, and
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

**Description** (shown to people on each repo's Documents page; never sent to the model)

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
