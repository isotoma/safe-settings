# Isotoma fork changes — `branch-from-main-enterprise-0cc709f`

Notes on what this fork carries on top of upstream `github/safe-settings`, why,
and what is still outstanding.

- **Base:** `main-enterprise` at `0cc709f` (`2.1.21-27-g0cc709f`)
- **Upstream remote:** `git@github.com:github/safe-settings.git`
- **Previous branch:** `branch-from-2.1.19-rc.1` (left untouched, now superseded)
- **Written:** 2 September 2026

## Why HEAD and not the `2.1.21` tag

`2.1.21` is the latest release on this line but sits 27 commits behind
`main-enterprise` HEAD, and those commits are mostly security work:

- `c73be50` — GHSA-52cp-r559-cp3m, transitive js-yaml
- `db9d78c` — lodash code-injection fix
- plus undici, body-parser, brace-expansion, js-yaml, flatted, shell-quote bumps

For a tool that applies settings org-wide with elevated permissions, starting
from a base missing those was not worth the reproducibility gain — and the exact
base SHA is recorded in the branch name anyway.

Note `3.0.0-rc.1` exists but is **not** on `main-enterprise`; it is a separate
line and not a candidate base.

---

## Theme 1 — Run safe-settings locally against a config checkout

The bulk of the branch. Normally safe-settings loads config from the `admin`
repo over the GitHub Contents API. `LOCAL_CONFIG_PATH` makes it read from a
local directory instead, so config changes can be iterated on without pushing
to the admin repo.

Declared at `lib/env.js` as `LOCAL_CONFIG_PATH: process.env.LOCAL_CONFIG_PATH || null`,
and wired into all four config-loading paths:

| Location | Loads |
|---|---|
| `lib/configManager.js:20` | deployment settings |
| `lib/settings.js:978` (`loadYaml`) | the main settings file |
| `lib/settings.js:570` (`loadConfigMap`) | single file **or** a directory listing of `*.yml`/`*.yaml` |
| `lib/settings.js:634` (`getRepoConfigMap`) | the `.github/repos/*.yml` listing |

Each local branch returns `null` or `[]` on `ENOENT`, mimicking a 404 from the
API so downstream code behaves unchanged. Anything other than `ENOENT` is
rethrown.

## Theme 2 — Stop full-sync crashing when run from the CLI

Both "potential bug" commits share one root cause: a CLI full-sync has no check
run and no pull request, but upstream assumed one.

- `lib/settings.js:266` — `env.CREATE_PR_COMMENT === 'true' && payload.check_run`.
  The PR-comment path dereferenced `payload.check_run.check_suite.pull_requests[0]`.
- `lib/settings.js:300` — the whole "complete the check run" block is now inside
  `if (payload.check_run)`. Upstream unconditionally read `payload.check_run.id`.
- `index.js:546` — upstream destructured `check_suite` out of `check_run` and
  then checked whether the event was even ours. An undefined `check_run` threw
  before the guard ran. The `source` check now comes first, and the check is
  `check_run && check_run.name === '...'`.

## Theme 3 — Make dry-run output readable

`full-sync.js` gained a results printer: per-change icon (`✗` for ERROR, `~`
otherwise), plugin, repo, endpoint, body, and only the non-empty
additions/modifications/deletions via a `hasKeys` helper.

Supporting changes:

- `lib/mergeDeep.js:277` — attaches the name/username field to **deletion**
  entries, matching what upstream already did for modifications. Without it,
  deletions printed as anonymous objects with no indication of what was being
  removed.
- `lib/plugins/archive.js:31` — the nop path passed `this.settings` to
  `endpoint()` instead of `{ owner, repo, archived }`, so the dry-run displayed
  the wrong endpoint. Also `modifications: { archived: action }` → `{ archived }`
  (the boolean, not the verb "archive"), and `additions`/`deletions` are now
  `null` rather than `{}` so the printer skips them.

Also in `full-sync.js`: `require('dotenv').config()`, `await probot.auth()`,
`settings && settings.results` guards, and `console.error('...', error)` so a
failure produces a stack trace rather than `[object Object]`.

## Theme 4 — See what it is doing during a sync

The "doing stuff" logs were promoted from `debug` to `info`, with a consistent
`[Plugin] owner/repo: verb` prefix:

- `lib/plugins/diffable.js` — per-item add/remove/update, using a new `itemName`
  helper built on `MergeDeep.NAME_FIELDS`
- `lib/plugins/archive.js`, `lib/plugins/branches.js`, `lib/plugins/repository.js:97`
- `lib/settings.js` — `Found N repositories`, `Processing repo: owner/name`

**Consequence:** the unit test log stubs only provided `debug`/`error`, so every
suite touching these paths died with `this.log.info is not a function`. Fixed by
adding `info` to the 11 stubs (see "Commits added during the rebase" below).
The old `branch-from-2.1.19-rc.1` still has this breakage — 19 failures.

## Theme 5 — Two genuine upstream bugs

### `bypass_pull_request_allowances` — the important one

`lib/plugins/branches.js:157`. Reading branch protection returns
`bypass_pull_request_allowances.teams` (and `users`, `apps`) as full **objects**,
but config specifies slugs. Without normalising, `compareDeep` sees a difference
on every run, so safe-settings rewrites branch protection every time — and
potentially clobbers the bypass list.

Upstream does exactly this mapping for `restrictions` a few lines above
(`.map(team => team.slug || team)`); they simply missed it here. Still unfixed
upstream as of `0cc709f`, so this must be carried.

### Undefined branch name in a log message

`lib/plugins/branches.js:68`. `params.branch` is a string — assigned from
`branch.name` or `currentRepo.data.default_branch` — so upstream's
`params.branch.name` is always `undefined` and the message reads
"...for undefined branch". Cosmetic, but real, and still present upstream.

---

## Commits dropped as superseded

### `a572dfb` "Fix for classic branch rules"

Upstream `edc9d29` (Bug/issue 465, #970) added the same four
`allow_force_pushes` / `block_creations` / `lock_branch` / `allow_fork_syncing`
lines, **plus** normalisation of `restrictions` and `required_status_checks`
that this fork never had. Upstream's version is a strict superset.

The one thing worth keeping from it was the `params.branch` fix, which was
carried over separately as `18678a6`.

### Most of `ff29bd7` "Fix for devcontainer build post proxy install"

Upstream had already fixed both devcontainer problems independently:

- `74f6fc4` deleted the `npm install -g npm` build step entirely, so the
  BuildKit secret for `~/.npmrc` is no longer needed at build time.
- The SAM CLI block already maps `aarch64` → `arm64`, which was the other bug
  (`dpkg --print-architecture` returns `amd64`, but the release asset is
  `x86_64`, so the download 404s and `unzip` fails with exit 9).

Only the **runtime** mount was still needed, since `postCreateCommand` still
runs `npm install`. That is all `8f16ed0` carries.

### `608cea3` + `aa15648` — `export-settings.js`

A net-zero pair. `608cea3` added a 241-line `export-settings.js`; `aa15648`
deleted it again ("move to admin" meant moving it out of this repo). The file
does **not** exist on this branch. If that script is still in use it lives in
the admin repo — worth confirming, because this branch is not its home.

---

## Conflicts hit during the rebase

Four, all the same cause: upstream `16feaad` migrated Octokit calls to the
`.rest` namespace for probot v14. Each resolution took upstream's namespace with
the local change layered on top.

| File | Resolution |
|---|---|
| `lib/settings.js` | `this.github.rest.checks.update` inside the new `if (payload.check_run)` guard |
| `lib/env.js` | purely additive — kept upstream's `GHE_HOST`/`GHE_PROTOCOL` and added `LOCAL_CONFIG_PATH` |
| `lib/plugins/archive.js` | `this.github.rest.repos.update.endpoint({ owner, repo, archived })` |
| `lib/plugins/branches.js` | ×2 — the `.rest` namespace with the `info` logging, and upstream's `restrictions`/`required_status_checks` blocks kept alongside the new bypass normalisation |

The `archive.js` resolution was independently confirmed correct: the real
(non-nop) call immediately below already used `{ owner, repo, archived }`, so
`this.settings` was definitely the wrong argument.

## Commits added during the rebase

- `8f16ed0` — devcontainer `~/.npmrc` read-only bind mount (see Theme 5 notes above)
- `0a7b2ef` — `a637f5e` replaced the log line that consumed `const { data }` in
  `archive.js`, leaving it unused and failing `no-unused-vars`
- `7e90a13` — added `info` to the 11 unit-test log stubs and updated the
  `archive.test.js` assertion from `log.debug` to `log.info`, matching the
  intent of the commit that promoted that line

---

## Verification against a clean `main-enterprise` worktree

| | baseline | this branch |
|---|---|---|
| Unit tests | 148 passed, 0 failed | 148 passed, 0 failed |
| eslint (whole repo) | 145 problems | 144 |
| `standard` | 148 lines | 147 |
| Integration tests | 7 suites / 8 tests failed | 7 suites / 8 tests failed |

Integration failures are pre-existing and identical to baseline — not caused by
this branch. The single lint improvement is the `archive.js` unused-var fix.

---

## Outstanding / worth knowing

1. **`dotenv` is not a declared dependency.** `full-sync.js:1` requires it, but
   it is absent from both `dependencies` and `devDependencies` — it resolves only
   transitively through probot. This works today by npm hoisting; a probot
   upgrade could break `full-sync` with "Cannot find module 'dotenv'". Should be
   added explicitly.

2. **`await probot.auth()` in `full-sync.js:8` is unexplained.** It authenticates
   the instance before `syncInstallation`, but nothing in the surrounding code
   makes obvious why it is required. Presumably added in response to an actual
   auth failure. Not inferable from the diff.

3. **Node ≥ 22 is now required.** `package.json` `engines` says `>= 22.0.0`, so
   `npm test` fails at `lint:engines` on a Node 20 host. Inside the devcontainer
   this is fine — upstream bumped `VARIANT` to `22-bookworm`. To run tests on a
   Node 20 host, invoke jest directly:
   `npx jest --roots=lib --roots=test/unit`

4. **The devcontainer mount is machine-specific.** The `${localEnv:HOME}` mount
   in `.devcontainer/devcontainer.json` should stay local and not be PR'd
   upstream. Both devcontainer files are tracked in a fork of a public repo.

5. **Two changes are candidate upstream PRs on their own merit:** the
   `bypass_pull_request_allowances` normalisation and the `params.branch` log
   fix. Both are genuine upstream bugs affecting all users.
