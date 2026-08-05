# AGENTS.md

Guidance for AI coding agents working in this repo.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as **GitHub issues** (via the `gh` CLI) in `imDev2023/Play-2-Earn`. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical five triage roles, with names unchanged (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

**Multi-context** layout - a `CONTEXT-MAP.md` at the repo root points to per-context `CONTEXT.md` files (e.g. contracts and frontend as separate contexts). These are created lazily by `/domain-modeling`, not upfront. See `docs/agents/domain.md`.

## Review cadence

**Run `/code-review` after every feature, and again over any commit that answers its findings.**

The second half is the half that keeps getting dropped, so it is the half worth stating plainly.
A fix written to close a review finding is new, unreviewed code.
It was written under the impression that the problem was already understood, which is exactly the state in which a fix reproduces the bug it was meant to remove.
That is not hypothetical here: the `toBetView` helper was added to stop the positional `bets()` trap and destructured the tuple by position, and only a review of the fix itself caught it.

Do not exempt a change because it looks small.
That reasoning is what put a red suite on #48 behind a PR body claiming it was clean, and what put the positional bug on #51's branch.
Size is not a proxy for risk on a money contract's client.

Review both axes.
`/code-review` runs Standards and Spec as separate sub-agents on purpose, and the two do not substitute for each other: code can follow every convention while implementing the wrong thing.
The Spec axis reads `docs/spec/RUSHOOD-game-spec.md`, and you should read it yourself rather than trust that a sub-agent did.

**If the sub-agents fail to run, say so.** Do not quietly substitute your own read of the diff and call it a review.
A self-review reported as a review is worse than no review, because it retires the task.

`/code-review ultra` is owner-triggered and billed. Never launch it yourself.

### Why this outranks the test suite here

Tests caught none of the defects in #41, #42 or #45, none of the admin authorisation hole, neither of the two missed `bets()` consumers in #48, not the refunded-bet-reads-pending bug, and not the `toBetView` reorder hazard.
Review and real use caught every one.
Write the tests anyway - but do not treat a green suite as evidence that a change is correct, and do not let it stand in for the review.

Related: reproduce a bug end to end before fixing it, and confirm the fix the same way.
