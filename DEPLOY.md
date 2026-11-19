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
- Upstream: `git fetch origin && git merge origin/main` into `deploy`, regularly. Conflicts are resolved in the merge.
- Before pushing `deploy`: `npm run typecheck` and `npm run test:unit` in `app/`, `npm test` in `web/`, and the suites
  (`node test/run-all.mjs`, also with `SOMA_TEST_TARGET=web`) when `app/` changed.

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

Old, kept until the pull requests are merged (their content is in the branches above, rebased): `web-version`,
`web-mirror` (now part of `web-synced-folder`), `backup/*`.
