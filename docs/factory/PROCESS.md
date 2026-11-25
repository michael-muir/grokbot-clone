# Software factory process

Every roadmap issue goes through the same steps, one issue at a time. Nothing reaches `main` without passing
every step.

```
pick → spec → build → check → review → approve → merge → next
```

## 1. Pick

- Take the next open issue in the current phase milestone, in the order of its gate issue's checklist.
- Skip an issue whose dependencies aren't merged, or that needs a decision from the owner (see Escalation).
- Branch from an up-to-date `main`: `issue-<number>-<short-slug>`.

## 2. Spec

Write `docs/specs/<number>-<short-slug>.md` from [`docs/specs/TEMPLATE.md`](../specs/TEMPLATE.md) and commit it
first. The spec states the goal, scope, design, interfaces, the test plan, and how each acceptance criterion
from the issue will be shown to pass. Anything left out of scope is named.

## 3. Build

- Small commits that each pass `npm run verify`.
- Follow [`CLAUDE.md`](../../CLAUDE.md) coding standards.
- Tests are written with the code, not after. Every acceptance criterion maps to at least one test, or to a
  manual check written down in the PR when a test isn't possible (for example a visual check).

## 4. Check

All of these must pass before review:

| Check | How |
| --- | --- |
| Lint and format | `npm run check` (Biome) |
| Types | `npm run typecheck` |
| Tests | `npm test`, offline, no API keys |
| Bugs | Self-review of the full diff for correctness, error paths, races, leaks and security |
| Coding standards | The diff follows `CLAUDE.md` |
| UI/UX (UI issues only) | Screenshot each changed screen, compare side by side with `reference/screens` and `design/previews`, check keyboard use, focus, light/dark, and reduced motion |

## 5. Review

- Open a pull request using the template. It links the spec and says `Closes #<number>`.
- Run a code review of the PR diff (`/code-review`) and record the findings in a PR comment.
- Fix every confirmed finding, re-run the checks, and note what changed.

## 6. Approve

The PR is approved when:

- every checklist item in the PR template is ticked,
- every acceptance criterion is shown to pass (test name or manual check),
- no review findings are left open,
- CI is green.

The approval is recorded as a PR comment with the verdict and a one-line summary.

## 7. Merge

- Squash merge into `main`, delete the branch.
- Tick the issue in its phase gate checklist.
- Pull `main` and go to the next issue.

## Escalation

Stop and ask the owner when:

- a decision is needed that the PRD leaves open (for example the container runtime, or naming and branding),
- something costs money or needs an account (API keys for live tests, signing certificates, Apple Developer),
- a task would act on the real Grok Bot or another real service,
- the issue's scope or acceptance criteria look wrong,
- a check fails in a way that can't be fixed inside the issue.

Work continues on other unblocked issues while waiting.
