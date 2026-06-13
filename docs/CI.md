# CI & auto-merge

GitHub Actions gates every PR; a labelled PR merges itself once the gate is green.

## The CI gate (`.github/workflows/ci.yml`)

Runs on every `pull_request` and on push to `main`. Four jobs, all required to merge:

| Check name (exact) | What it does | Needs |
|---|---|---|
| `Secret scan (gitleaks)` | gitleaks over the full history | — |
| `Server — unit + node smoke tier` | `test:unit:coverage` (coverage thresholds) + `npm test` (node-only smokes) | — |
| `Server — migrations + DB smoke` | `db:migrate` → `db:smoke` → `users:seed` → `auth:smoke` against a Postgres service | Postgres (CI service container) |
| `Web — lint + build` | oxlint + eslint + `vite build` | — |

No LLM runs on CI runners (`LLM_BOOT_CHECK=warn`); the LLM/eval tiers (`smoke:full`, `eval`) are local/nightly only, never a PR gate.

## Auto-merge (`.github/workflows/automerge.yml`)

Opt-in, label-driven:

1. Open a PR as usual.
2. Add the **`automerge`** label.
3. The workflow enables GitHub native auto-merge (`gh pr merge --auto --squash --delete-branch`).
4. When the four CI checks pass, GitHub **squash-merges into `main`** and **deletes the branch**.

Remove the label to disarm. No label ⇒ nothing auto-merges.

### Supporting config (one-time, applied via the GitHub API — not in the repo)

- **Repo settings:** `allow_auto_merge`, `delete_branch_on_merge`, squash-only (`allow_merge_commit`/`allow_rebase_merge` off); squash commit uses the PR title + body.
- **Branch ruleset on `main`** (`main: require green CI via PR`): requires a PR (0 approvals) + the four CI checks green before any update to `main`; blocks branch deletion and non-fast-forward. **Repo admins bypass** (escape hatch). Required checks are non-strict, so a PR won't stall if `main` advances after its CI started.

## Consequences / gotchas

- **Direct pushes to `main` are blocked** for non-admins — land changes via a PR. Admins can bypass, but the PR path is the intended one.
- **Renaming a CI job breaks the gate.** The ruleset pins the four required checks by their exact job `name`. If you rename a job in `ci.yml` (or add a new one that should gate), update the ruleset's required-status-check contexts to match — otherwise auto-merge waits forever on a check that never reports. Update them with:
  ```bash
  # inspect current required contexts
  gh api repos/jbillay/SentinelKYC/rules/branches/main \
    --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
  # then PATCH the ruleset (id 17635386) with the new context list
  gh api -X PUT repos/jbillay/SentinelKYC/rulesets/17635386 --input <updated-ruleset.json>
  ```
