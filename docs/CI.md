# CI & auto-merge

GitHub Actions gates every PR; a labelled PR merges itself once the gate is green.

## The CI gate (`.github/workflows/ci.yml`)

Runs on every `pull_request` and on push to `main`. Four work jobs plus one aggregating gate:

| Job | What it does | Needs |
|---|---|---|
| `Secret scan (gitleaks)` | gitleaks over the full history | — |
| `Server — unit + node smoke tier` | `test:unit:coverage` (coverage thresholds) + `npm test` (node-only smokes) | — |
| `Server — migrations + DB smoke` | `db:migrate` → `db:smoke` → `users:seed` → `auth:smoke` against a Postgres service | Postgres (CI service container) |
| `Web — lint + build` | oxlint + eslint + `vite build` | — |
| `CI gate` | `needs:` all four; fails unless every one succeeded. **The only check the `main` ruleset requires.** | the four above |

The ruleset requires **only `CI gate`** (one stable name), so renaming any work job's display `name:` never breaks merging. No LLM runs on CI runners (`LLM_BOOT_CHECK=warn`); the LLM/eval tiers (`smoke:full`, `eval`) are local/nightly only, never a PR gate.

## Auto-merge (`.github/workflows/automerge.yml`)

Opt-in, label-driven:

1. Open a PR as usual.
2. Add the **`automerge`** label.
3. The workflow enables GitHub native auto-merge (`gh pr merge --auto --squash --delete-branch`).
4. When the four CI checks pass, GitHub **squash-merges into `main`** and **deletes the branch**.

Remove the label to disarm. No label ⇒ nothing auto-merges.

### Merged-branch deletion (`.github/workflows/branch-sweep.yml`)

The label flow arms auto-merge as the **github-actions bot**, and GitHub suppresses the events caused by `GITHUB_TOKEN` — so `delete_branch_on_merge` and any `pull_request: closed` cleanup never fire for an auto-merged PR. Instead, a **scheduled sweep** (hourly + `workflow_dispatch`) reaps them: it deletes the head branch of every merged PR that is in this repo, isn't the default branch, and has no open PR pointing at it. A schedule-triggered run isn't subject to the `GITHUB_TOKEN` suppression. Trigger it on demand from **Actions → Merged-branch sweep → Run workflow**.

### Supporting config (one-time, applied via the GitHub API — not in the repo)

- **Repo settings:** `allow_auto_merge`, `delete_branch_on_merge`, squash-only (`allow_merge_commit`/`allow_rebase_merge` off); squash commit uses the PR title + body.
- **Branch ruleset on `main`** (`main: require green CI via PR`): requires a PR (0 approvals) + the four CI checks green before any update to `main`; blocks branch deletion and non-fast-forward. **Repo admins bypass** (escape hatch). Required checks are non-strict, so a PR won't stall if `main` advances after its CI started.

## Consequences / gotchas

- **Direct pushes to `main` are blocked** for non-admins — land changes via a PR. Admins can bypass, but the PR path is the intended one.
- **Adding a job that should block merges?** Add its job-id to `ci-gate`'s `needs:` list in `ci.yml`. The ruleset requires only `CI gate`, so the gate is what decides. Renaming a work job's display `name:` is safe (the ruleset never references it); renaming a job-*id* requires updating `needs:` too — and a stale `needs:` entry is a loud workflow error, not a silently stuck merge. The ruleset itself (id `17635386`) almost never needs to change. To inspect / change its required check:
  ```bash
  # inspect current required contexts (should be just "CI gate")
  gh api repos/jbillay/SentinelKYC/rules/branches/main \
    --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
  # only if you ever rename the gate job itself: PATCH the ruleset
  gh api -X PUT repos/jbillay/SentinelKYC/rulesets/17635386 --input <updated-ruleset.json>
  ```
