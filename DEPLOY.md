# Branch `deploy` (fork mat100/SOMA)

What our own installation of SOMA runs (the web version in Coder workspaces): upstream `main` plus our changes, those
on their way upstream and those that stay with us. This file exists only on this branch.

## Rules

- Every development branch ends up here: `deploy` is where they all meet. A branch that is not merged into `deploy` is
  not part of our installation.
- No pull request is ever opened from `deploy` (it holds everything, including what stays with us). Pull requests to
  upstream come from the feature branches only.
- `deploy` only moves forward by merges: no rebase, no force push. Coder templates and installations follow it.
- Every change has a branch of its own and comes in with `git merge --no-ff <branch>`. Nothing is committed on `deploy`
  directly, except merge resolutions and this file.
- Changes for upstream: branch from upstream `main` (or from the branch they build on), pull request to upstream, merge
  into `deploy` as well. Once upstream has merged them, the next merge of upstream `main` brings them in again: nothing
  else to do.
- Changes that stay with us: branch from `web` (or `deploy` when they need more), merge into `deploy` only.
- Upstream: `git fetch origin && git merge origin/main` into `deploy` at least once a week and whenever upstream makes a
  release, then the full tests below. Conflicts are resolved in the merge.
- Before pushing `deploy`: `npm run typecheck` and `npm run test:unit` in `app/`, `npm test` in `web/`, and the suites
  (`node test/run-all.mjs`, also with `SOMA_TEST_TARGET=web`) when `app/` changed.
- A merge is done when it is on the fork: push the branch and `deploy` at the end of every piece of work, then check
  with `git branch -r --contains <merge commit>` that `fork/deploy` has it. A merge only in a local `deploy` is not
  deployed.
- After the push the running server is rebuilt from `deploy` and checked: `GET /health` (and the start page, next to the
  version) names the commit it runs. In the Coder workspace `soma-web-dev` does both (`~/.local/bin`).
- Changes in `app/` are ports only (`platform.ts`, an optional parameter), in commits of their own (`App: …`) with a
  test, never mixed with `web/` in one commit: they go upstream as pull requests later, and clean ones get through.

## Worktrees (Coder workspace)

One branch per worktree, the name of the branch does not change while it has one. `app/node_modules` and
`web/node_modules` of a new worktree are links to those of `~/SOMA-deploy`.

| Worktree | Branch |
|---|---|
| `~/SOMA-deploy` | `deploy` (the dev server on port 5173 runs from here) |
| `~/SOMA` | `platform-interface` |
| `~/SOMA-web` | `web` |
| `~/SOMA-folder` | `web-synced-folder` |
| `~/SOMA-buildinfo` | `web-build-info` |
| `~/SOMA-signin` | `web-somaai-signin` |
| `~/SOMA-mirror` | `backup/web-mirror-old` (old, nothing new here) |

## Branches in it

Pull requests to upstream (agreed in issue #14, in this order; each one rebased onto the current upstream `main` and
the one before it right before it is opened):

| Branch | Base | PR | What | Still to do before the PR |
|---|---|---|---|---|
| `linux-watcher-fix` | upstream `main` | 1 | File watching on Linux | Rebase (CHANGELOG conflict); upstream must let us open PRs |
| `platform-interface` | upstream `main` | 2 | The main process behind `platform.ts`, incl. voice input | Rebase; port `versions:cancelPreview` and `test:size` into `commands.ts`/`api.ts` (done in the merge into `deploy`) |
| `web` | `platform-interface` | 3 | The web version (`web/`) and its test fixes in `app/test` | Rebase onto PR 2; Linux job for the web tests in `.github/workflows/checks.yml` |

Ours only, never a pull request:

| Branch | Base | What |
|---|---|---|
| `somaai-claude-subscription` | `web` | SOMA AI: sign-in with a Claude Pro/Max plan; may use the temp folder and read system files without asking |
| `web-synced-folder` | `web` | Synced folder (`SOMA_MIRROR_DIR`, Coder Desktop file sync): results of each model, and the folder as the models' home |
| `web-build-info` | `web` | Which commit the server runs: start page next to the version, `GET /health`, log |
| `web-somaai-signin` | `deploy` | SOMA AI in the web version: Claude sign-in by Anthropic's copy-code login (`Platform.remoteBrowser`) |

Old, kept until the pull requests are merged (their content is in the branches above, rebased): `web-version`,
`web-mirror` (now part of `web-synced-folder`), `backup/*`.

## Decisions (ours only)

Decisions about what stays with us; those of the web version for upstream are in `web/README.md` ("Decisions"). New
rows at the end, old rows are not rewritten.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-11-19 | `deploy` holds everything and is never the source of a pull request; upstream PRs only from `linux-watcher-fix`, `platform-interface`, `web` | One branch for the installation, clean branches for upstream |
| D2 | 2026-11-19 | Synced folder (`SOMA_MIRROR_DIR`): a one-way copy of each model's results, nothing is ever deleted there, files changed by the user are never overwritten (`… (from SOMA)`) | Coder Desktop syncs the folder to the user's computer; a sync tool must not lose the user's work |
| D3 | 2026-11-19 | The synced folder is the models' home only when it lies inside `SOMA_WEB_FILES`: a new model asks for its name and gets `<name>/`, Ctrl+S saves `<name>/<name>.soma` without a dialog | Without the condition the behavior and the tests of a plain synced folder stay as they were |
| D4 | 2026-11-19 | A model's folder is renamed only when everything in it is SOMA's (manifest files unchanged, `versions/`, the manifest); otherwise a new folder and one notice | Never move or delete what the user put there |
| D5 | 2026-11-19 | `GET /health` answers without the token with version and commit | The code is public (GPL); a check after a deployment needs no secret |
| D6 | 2026-11-19 | At the end of every piece of work the branch and `deploy` are pushed to the fork without asking; force pushes and pull requests only with the user's consent | The user wants the installation to follow without a separate step |
| D7 | 2026-11-19 | In the web version Claude (Pro/Max) signs in by pi's copy-code login: the user pastes `code#state` from platform.claude.com; the desktop keeps the browser login | claude.ai cannot send the browser back to the server's localhost (the page only spins); the copy-code page is what Claude Code uses without a local browser |
