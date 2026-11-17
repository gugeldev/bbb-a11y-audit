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

Ask your agent to run the `a11y-audit` skill, for the whole client, one guideline (e.g. `diretriz 1.4`), a single criterion, a folder, or just the branch diff.

The report is organized by principle and guideline, so each guideline can be a work phase. Every criterion ends up failing, passing, not applicable, or, only where a person is truly needed, waiting for a human check with a ready-made script. The report also records whether each criterion was checked by a tool, by the agent, or by a person. Reports go to `a11y-reports/<date>_<time>/report.html`, and each run is compared with the previous one.
