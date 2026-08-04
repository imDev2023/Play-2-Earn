# AGENTS.md

Guidance for AI coding agents working in this repo.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as **GitHub issues** (via the `gh` CLI) in `imDev2023/Play-2-Earn`. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical five triage roles, with names unchanged (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Formatting: never run bare `npx prettier`

The repo has **no prettier config** and `lint` is `next lint` (ESLint only), but a transitive **prettier 2.8.8** sits in `node_modules`, so `npx prettier` silently reformats at width 80 with different trailing-comma rules and produces hundreds of lines of churn.

The actual style is **prettier 3 at `--print-width 100`**. Verify with `npx prettier@3 --print-width 100 --check <an untouched file>`.

Worse, a bad pass does not fully undo: prettier keeps an object literal expanded once anything has broken it. Recovery is `git checkout HEAD -- <files>` and re-applying the edits by hand.

### Dependency advisories

Six high advisories are open and accepted, all in code that does not reach a browser. CI gates at `critical`. See `docs/ops/dependency-advisories.md` before changing the threshold or adding an ignore.

### Domain docs

**Multi-context** layout - a `CONTEXT-MAP.md` at the repo root points to per-context `CONTEXT.md` files (e.g. contracts and frontend as separate contexts). These are created lazily by `/domain-modeling`, not upfront. See `docs/agents/domain.md`.
