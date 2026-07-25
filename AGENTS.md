# AGENTS.md

Guidance for AI coding agents working in this repo.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as **GitHub issues** (via the `gh` CLI) in `imDev2023/Play-2-Earn`. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical five triage roles, with names unchanged (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

**Multi-context** layout — a `CONTEXT-MAP.md` at the repo root points to per-context `CONTEXT.md` files (e.g. contracts and frontend as separate contexts). These are created lazily by `/domain-modeling`, not upfront. See `docs/agents/domain.md`.
