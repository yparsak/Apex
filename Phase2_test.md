# Phase 2 manual testing

Phase 2 adds repo/branch selection & CO resolution: a GitHub branch-existence
service, a pipeline-lock table/module, JSON API routes under `/api/repos`,
and a minimal server-rendered UI (login page, repo list, branch selection)
built with EJS + Bootstrap. See `roadmap.md`'s "Phase 2" section for the
scope this implements, and `agent-prompts.md` for the token-minting service
it calls into.

There is still no admin UI (Phase 6) for granting repo access, so this doc
includes the raw SQL to seed `orgs` / `repo_groups` / `repos` /
`user_repo_group_permissions` rows directly.

## Prerequisites

1. Everything from `phase0.setup.md` (MariaDB running, schema applied,
   `.env` with `DB_*`, `SESSION_SECRET`, `AUTH_PROVIDER`) and
   `Phase1_test.md` (a working GitHub App — `GITHUB_APP_ID`,
   `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` — installed on
   at least one real repo you can freely create/delete branches on).
2. **No new `.env` variables are introduced in Phase 2** — it reuses the
   Phase 0/1 config as-is.
3. A GitHub repo the App is installed on, with a `main` branch that exists
   (or note its actual default branch name — you'll set
   `repos.default_branch_name` to match when you seed the `repos` row
   below; Phase 2 reads that column rather than assuming `main` in code,
   even though `main` is its schema default).
4. **`ejs` is a new dependency.** Run `make install` (`npm install`) after
   pulling these changes — the code in this branch could not run `npm
   install` itself in the environment it was written in, so `package.json`
   lists `ejs` but `package-lock.json` has **not** been regenerated. Running
   `make install` locally will update the lockfile correctly; do this before
   starting the server.
5. Re-apply the schema to pick up the new `pipeline_locks` table (safe to
   re-run — every statement is `CREATE TABLE IF NOT EXISTS`):

   ```
   make db-schema
   ```

## Seed test data

There's no admin UI yet, so create an org / repo group / repo / permission
row by hand. Replace `your-github-owner` and `your-test-repo` with the
actual GitHub org-or-username and repo name the App is installed on —
**`orgs.name` is treated as the GitHub owner login** (see the comment in
`app/lib/repos/repoAccess.js` for why: the `repos` table has no separate
owner column, and `orgs.name` is the closest existing field, whether that
owner is really a GitHub org or a personal account).

```sql
INSERT INTO orgs (name) VALUES ('your-github-owner');
INSERT INTO repo_groups (org_id, name) VALUES (LAST_INSERT_ID(), 'Test Group');
INSERT INTO repos (repo_group_id, name, default_branch_name)
  VALUES (LAST_INSERT_ID(), 'your-test-repo', 'main');
```

Run that with e.g. `mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p $DB_NAME`.
Note the `repos.id` this produces (`SELECT id FROM repos WHERE name =
'your-test-repo';` if you didn't capture it).

Register two users (reusing the Phase 0 endpoint) so you can exercise the
"any user can continue on any existing branch, but creates under their own
initials" behavior:

```
curl -s -c jdoe.cookies.txt -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"jdoe","password":"correct-horse","initials":"JD"}'

curl -s -c asmith.cookies.txt -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"asmith","password":"correct-horse","initials":"AS"}'
```

Grant both users access to the repo group:

```sql
INSERT INTO user_repo_group_permissions (user_id, repo_group_id)
  SELECT id, <repo_group_id> FROM users WHERE username IN ('jdoe', 'asmith');
```

(`<repo_group_id>` is the id from the `repo_groups` insert above.)

## Start the app

```
make dev
```

## Test 1 — repo list (API)

```
curl -s -b jdoe.cookies.txt http://localhost:3000/api/repos | json_pp
```

**Success looks like:** `{"success":true,...,"data":{"repos":[{"id":<id>,"name":"your-test-repo",...}]}}`.

Without the cookie jar (i.e. unauthenticated), the same call should 401:

```
curl -s http://localhost:3000/api/repos
```
→ `{"success":false,"message":"Not authenticated","error":{}}`

## Test 2 — empty branch list (API)

```
curl -s -b jdoe.cookies.txt "http://localhost:3000/api/repos/<repo_id>/branches" | json_pp
```

**Success looks like:** `"branches": []` — no GitHub calls happen yet when
there are zero DB candidates (see `refreshActiveBranches`'s early return),
so this should return instantly even with bad GitHub credentials.

## Test 3 — create the first branch for a CO

```
curl -s -b jdoe.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"coNumber":"C10000001","action":"create"}' | json_pp
```

**Success looks like:** `data.branch.branchName` is `dev/JD-C10000001-1`,
`data.changeOrder.coNumber` is `C10000001`. Confirm on GitHub (web UI or
`git ls-remote`) that the branch exists and was cloned from `main` (same
commit SHA as `main` at the time).

Check the DB:

```sql
SELECT branch_name, status FROM branches;          -- one active row
SELECT repo_id, co_number, locked_by_user_id FROM pipeline_locks;  -- one row
```

The lock row is expected to still be there — Phase 2 acquires the lock at
resolution and only releases it on failure; releasing on a *successful*
full pipeline run is Phase 5's job, which doesn't exist yet. Keep this in
mind for the rest of the tests below: **any second `resolve` call against
the same `(repo, coNumber)` will 409 until you manually delete that lock
row.**

## Test 4 — branch list now shows it, with an owner badge and no session yet

```
curl -s -b jdoe.cookies.txt "http://localhost:3000/api/repos/<repo_id>/branches?co=C10000001" | json_pp
```

**Success looks like:** one branch, `isMine: true`, `mySessionStatus: null`
(no session exists yet — Phase 3+ creates those).

## Test 5 — lock enforcement (409)

Immediately repeat Test 3's exact request (same CO, same repo).

**Success looks like:** HTTP 409, `{"success":false,"message":"Pipeline
lock already held for repo <id>, CO C10000001",...}`.

Clear the lock to keep testing:

```sql
DELETE FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = 'C10000001';
```

## Test 6 — a second user continues on the first user's branch

Any user can continue on any existing active branch regardless of who
created it (roadmap.md's "no-ownership at selection" decision). After
clearing the lock in Test 5:

```
curl -s -b asmith.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"coNumber":"C10000001","action":"continue","branchId":<branch_id>}' | json_pp
```

**Success looks like:** `data.branch.branchName` is still
`dev/JD-C10000001-1` (asmith didn't create a new branch, just attached to
JD's). Clear the lock again afterward if you want to keep testing this CO.

## Test 7 — a second user's own parallel branch on the same CO

Clear the lock again, then have asmith **create** (not continue) against
the same CO:

```
curl -s -b asmith.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"coNumber":"C10000001","action":"create"}' | json_pp
```

**Success looks like:** `dev/AS-C10000001-1` — a second, independent branch
for the *same* CO, numbered from AS's own `-1` rather than continuing JD's
sequence. This is Accepted Risk #7's parallel-branches model:
`(repo_id, initials, co_number)` each get their own increment sequence. The
branch list for `co=C10000001` should now show both branches, and the
"Mine only" toggle (browser UI) or comparing `isMine` (API) should
distinguish them per logged-in user.

## Test 8 — CO format validation

```
curl -s -b jdoe.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"coNumber":"12345","action":"create"}'
```

**Success looks like:** HTTP 400, `coNumber must match ^C[0-9]{8}$`. Try the
same malformed value as a `?co=` query param against Test 4's endpoint for
the same 400 behavior.

## Test 9 — on-demand deletion detection

Delete one of the branches you created (`dev/JD-C10000001-1` or
`dev/AS-C10000001-1`) directly on GitHub (web UI: repo → Branches → delete
icon, or `git push origin --delete <branch>`).

Re-request the branch list:

```
curl -s -b jdoe.cookies.txt "http://localhost:3000/api/repos/<repo_id>/branches?co=C10000001" | json_pp
```

**Success looks like:** the deleted branch no longer appears in `data.branches`.

```sql
SELECT branch_name, status FROM branches WHERE co_number = 'C10000001';
```

**Success looks like:** the deleted branch's row now shows `status =
'deleted'` with an updated `last_checked_at` — flipped automatically by the
render-time check, not by anything you did manually.

## Test 10 — browser click-through

1. Open `http://localhost:3000/` — redirects to `/login`.
2. Log in as `jdoe` / `correct-horse`. On success you land on `/repos`.
3. `/repos` lists `your-test-repo`. Click it → `/repos/<id>/branches`.
4. Enter a fresh CO number (format `C12345678`) in the CO field, click
   **Filter**. The table should show "No active branches match" (or
   whatever's already there for that CO) and a **Create next branch** card
   should appear below it.
5. Click **Create next branch**. A green confirmation banner appears
   (`Resolved: dev/JD-<CO>-1 (...)`), and the table refreshes to show the
   new branch with a blue **"You (JD)"** badge.
6. Click **Log out**, then log in as `asmith` / `correct-horse`.
7. Go to the same repo's branch page, enter the same CO, click **Filter**.
   You'll see JD's branch with a grey **"JD"** badge (not "You") and a
   **Continue** button.
8. Toggle **Mine only** — the list should empty out (asmith owns nothing
   for this CO yet); toggle back to **All branches**.
9. Click **Continue** on JD's branch. Because the CO's pipeline lock is
   still held from step 5, this will show a red error banner mentioning
   "already held". Clear it via the SQL from Test 5, then click **Continue**
   again — it should now succeed with a green confirmation banner.

## What this does and doesn't prove

This proves repo/branch listing, on-demand GitHub deletion detection,
CO-format validation, the pipeline lock, and both branch-resolution paths
(continue / create) work end-to-end against a real GitHub repo. It does
**not** exercise anything from Phase 3 onward — there is no clarification
loop, no sandboxed execution, and no automatic lock release on success (see
Test 3's note). `mySessionStatus` will be `null` for every branch until
Phase 3/4 start writing rows into `sessions`.

## Common errors

| Symptom | Likely cause |
|---|---|
| `Not authenticated` (401) on any `/api/repos*` or page route | No session cookie sent — use `-b`/`-c cookies.txt` with curl, or log in again in the browser (sessions are in-memory and reset on server restart, per `phase0.setup.md`) |
| `Repo not found or access denied` (404) | The `user_repo_group_permissions` row for that user/repo group is missing, or `<repo_id>` in the URL doesn't match a repo you seeded |
| `co must match ^C[0-9]{8}$` / `coNumber must match ^C[0-9]{8}$` (400) | CO number isn't exactly `C` + 8 digits |
| `Pipeline lock already held for repo <id>, CO <co>` (409) | A previous `resolve` for that exact `(repo, CO)` succeeded and its lock was never released — expected in Phase 2 (see Test 3); clear it with `DELETE FROM pipeline_locks WHERE repo_id = ? AND co_number = ?` |
| `Active branch not found for this CO on this repo` (404) | `action: "continue"` was called with a `branchId` that isn't an active branch on that repo for that CO (wrong id, wrong CO, or it was just marked `deleted`) |
| `Failed to refresh branch list from GitHub` (502) | GitHub App creds wrong/missing (see `Phase1_test.md`'s error table), or `orgs.name`/`repos.name` don't exactly match the real GitHub owner/repo |
| `Failed to resolve "main" SHA (404): ...` | `repos.default_branch_name` doesn't match an actual branch on GitHub (e.g. the repo's default is `master`, not `main` — update the `repos` row) |
| `Failed to create branch "dev/..." (422): ...` | A branch with that exact computed name already exists on GitHub (e.g. created manually, bypassing this app) |
| `Failed to create branch "dev/..." (403): ...` | The GitHub App isn't installed on this repo, doesn't have `contents: write`, or a repository ruleset is blocking pushes to `dev/**` from something other than this App's installation |
| `Cannot find module 'ejs'` on server start | `make install` wasn't run after pulling Phase 2 (see Prerequisites #4) |
| Visiting `/repos` or a branch page while logged out redirects to `/login` instead of showing data | Expected: page routes use a redirect-to-`/login` guard (`requirePageAuth` in `app/routes/pages.js`), distinct from the JSON `requireAuth` used by `/api/repos/*` — log in first, then navigate back |
