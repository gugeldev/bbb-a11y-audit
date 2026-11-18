# bbb-a11y-audit

An agent skill that audits the BigBlueButton HTML5 client against **WCAG 2.2 A/AA** (EN 301 549 clause 9) and writes an HTML report.

Each finding comes with the criterion, evidence, a screenshot with the problem marked, a fix, a way to verify it, an impact and an effort. Everything in the chosen topic is meant to be fixed in that phase; only what cannot fit (external libraries, large redesigns) goes to a backlog, with the reason.

## How it works

- **Static**: pattern scan and `eslint-plugin-jsx-a11y`.
- **Runtime**: axe-core and Playwright in a live meeting, across about 60 screens (moderator, attendee, guest, pt-BR, dark theme, mobile). It also checks reflow, text spacing and keyboard, and records what a screen reader would hear.
- **Review**: the agent reads the code of the core flows for what tools can't decide.

## Install

Paste this into your coding agent, from your BigBlueButton checkout:

```text
Install the agent skill from https://github.com/gugeldev/bbb-a11y-audit into this project:
copy its `bbb-a11y-audit/` folder into the skills folder you load project skills from
(for Claude Code that is `.claude/skills/`). Don't run it yet; just confirm it is installed
and show me how to run it for one guideline.
```

Or by hand: copy `bbb-a11y-audit/` into your agent's skills folder. It uses the standard `SKILL.md` format.

The live-meeting layer sets itself up on the first run: it copies its Playwright files into `bigbluebutton-tests/playwright/accessibility/` and installs `@axe-core/playwright`. It needs `BBB_URL` and `BBB_SECRET` for a test server in `bigbluebutton-tests/playwright/.env`. Without them, that layer is skipped and the rest still runs.

## Use

Work one topic at a time: pick a guideline, audit everything in it, fix what was found, run it again until it is done, then move on.

```text
diretriz 2.1      # one guideline (or several, or "principio 2")
criterio 2.4.7    # one criterion
full              # all 55 criteria, as an overview to choose the next topic
```

A topic run only checks and reports that topic, and it compares against the last run of the same topic, so you can see what was fixed. Every criterion ends up failing, passing, not applicable, or, only where a person is truly needed, waiting for a human check with a ready-made script. The report also says whether each criterion was checked by a tool, by the agent, or by a person.

Reports go to `a11y-reports/<date>_<time>_<topic>/report.html`.

## What runs where

| Step | Runs | Where | Code |
| --- | --- | --- | --- |
| Static scan | Node, regex over the source | your checkout | `scripts/static-scan.mjs`, patterns in `scripts/lib/static-patterns.mjs` |
| eslint jsx-a11y | eslint 8, cached in `~/.cache/a11y-audit-eslint` | your checkout | `scripts/eslint-a11y.sh` |
| Runtime | Playwright (Chromium) + axe-core against a live meeting | the BigBlueButton test suite, `bigbluebutton-tests/playwright/accessibility/` (copied there on first run) | `runtime/*.ts` |
| Triage, review, coverage | the agent | the conversation | `SKILL.md` and `references/` |
| Validation and report | Node | your checkout | `scripts/build-report.mjs`, modules in `scripts/lib/` |

The tools only produce candidates and data; the agent decides what is a finding. `build-report.mjs` then rejects any finding whose file, line or quoted code does not exist, and any criterion of the topic left undecided.

## Development

The skill has no dependencies. This repository has dev tooling only:

```bash
npm install
npx playwright install chrome   # once, for the runtime tests
npm test                        # scripts (node:test) and runtime helpers (Playwright, no BBB server needed)
npm run format:check            # Prettier, same config as the BigBlueButton test suite
```

The runtime spec imports helpers from the BigBlueButton suite, so type-check it there (`npm run typecheck` in `bigbluebutton-tests/playwright/` after copying `runtime/*.ts` into `accessibility/`). It targets `v4.1.x-develop`.
