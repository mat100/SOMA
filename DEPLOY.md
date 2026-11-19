# Branch `deploy` (fork mat100/SOMA)

What our own installation of SOMA runs (the web version in Coder workspaces): upstream `main` plus our changes, those
on their way upstream and those that stay with us. This file exists only on this branch.

## Rules

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

| Branch | Base | Upstream? | What |
|---|---|---|---|
| `linux-watcher-fix` | upstream `main` | PR 1 (issue #14) | File watching on Linux |
| `platform-interface` | upstream `main` | PR 2 | The main process behind `platform.ts` |
| `web` | `platform-interface` | PR 3 | The web version (`web/`) |
| `web-mirror` | `web` | no | Synced folder for results (`SOMA_MIRROR_DIR`, Coder Desktop file sync) |
| `somaai-claude-subscription` | `web` | not yet decided | SOMA AI sign-in with a Claude Pro/Max plan |
