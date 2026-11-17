# bbb-a11y-audit

An agent skill that audits the BigBlueButton HTML5 client against **WCAG 2.2 A/AA** (EN 301 549 clause 9) and writes a prioritized HTML report.

Each finding comes with the criterion, evidence, a screenshot with the problem marked, a fix, a way to verify it, and a priority (impact × effort).

## How it works

- **Static**: pattern scan and `eslint-plugin-jsx-a11y`.
- **Runtime**: axe-core and Playwright in a live meeting, across about 60 screens (moderator, attendee, guest, pt-BR, dark theme, mobile). It also checks reflow, text spacing and keyboard, and records what a screen reader would hear.
- **Review**: the agent reads the code of the core flows for what tools can't decide.

## Install

1. Copy `a11y-audit/` into your agent's skills folder. It uses the standard `SKILL.md` format.
2. Copy `playwright/*.ts` into `bigbluebutton-tests/playwright/accessibility/`.
3. Run `npm install @axe-core/playwright` in `bigbluebutton-tests/playwright`.
4. Set `BBB_URL` and `BBB_SECRET` in that folder's `.env`. This is optional: without a server, the runtime layer is skipped.

## Use

Work one topic at a time: pick a guideline, audit everything in it, fix what was found, run it again until it is done, then move on.

```text
diretriz 2.1      # one guideline (or several, or "principio 2")
criterio 2.4.7    # one criterion
full              # all 55 criteria, as an overview to choose the next topic
```

A topic run only checks and reports that topic, and it compares against the last run of the same topic, so you can see what was fixed. Every criterion ends up failing, passing, not applicable, or, only where a person is truly needed, waiting for a human check with a ready-made script. The report also says whether each criterion was checked by a tool, by the agent, or by a person.

Reports go to `a11y-reports/<date>_<time>_<topic>/report.html`.
