---
name: a11y-audit
description: Audit the BigBlueButton HTML5 client against WCAG 2.2 level A and AA (EN 301 549 clause 9) and produce a prioritized HTML report of findings, each with criterion, evidence, fix, how to verify, impact and effort. Combines a static scan, an axe-core/Playwright run against a live meeting and a guided code review, and compares with previous runs (new, regressed, fixed). Use when the user asks for an accessibility or WCAG audit, an a11y report, to check a component, folder or criterion for accessibility, or to review a branch's changes for accessibility regressions.
---

# Accessibility audit (WCAG 2.2 AA)

Produce an honest, prioritized list of accessibility problems that can be turned into small tasks. The audit is **read-only**: do not change application code while auditing, even for obvious fixes. Fixing is a separate request.

Skill directory: the folder that contains this SKILL.md (below: `$SKILL`; in this repository usually `.claude/skills/a11y-audit`). References, read when the step needs them:

- `references/criteria.md`: the 55 criteria, which layer can evaluate each, BBB hotspots, coverage rules
- `references/rubric.md`: impact, effort, priority, grouping, stable keys, the `findings.input.json` schema
- `references/static-patterns.md`: static tools, how to triage each pattern, eslint and axe mappings
- `references/bbb-map.md`: flows, code locations, shared components, how to run the runtime layer
- `references/manual-checks.md`: screen reader scripts

## 1. Scope and mode

Read the arguments:

| Invocation | Mode | Scope |
| --- | --- | --- |
| `/a11y-audit` or `full` | `full` | `bigbluebutton-html5/imports/ui` and `bigbluebutton-html5/client` |
| `/a11y-audit <path>` | `path` | that folder or file |
| `/a11y-audit criterio 2.4.7` (or `criterion`) | `criterion` | whole client, only the given criteria; others are `skip` |
| `/a11y-audit diff [base]` | `diff` | files changed vs `git merge-base HEAD <base>` (default base: the repo main branch, `v4.0.x-develop`) under `bigbluebutton-html5/` |
| add `--no-runtime` | | skip the runtime layer |

If the request is ambiguous, pick the closest mode and say which one you used. Do not ask.

Create the run directory at the repo root: `a11y-reports/<YYYY-MM-DD_HHMM>/raw/`. The name must sort chronologically: the report compares against older sibling directories. `a11y-reports/` is git-ignored.

## 2. Static layer

```bash
node $SKILL/scripts/static-scan.mjs <scope paths…> > <run>/raw/static.json
$SKILL/scripts/eslint-a11y.sh <run>/raw/eslint.json <scope paths…>
```

Then triage every candidate as described in `references/static-patterns.md`: open the code, decide, group by root cause. Rejected candidates go to `discarded` with a reason. If a previous run exists, read its `findings.json` `discarded` list and reuse decisions for unchanged code instead of re-reading it.

## 3. Runtime layer

Check whether it can run (`bigbluebutton-tests/playwright/.env` has non-empty `BBB_URL` and `BBB_SECRET`, `node_modules` exists, a Chromium is installed). If anything is missing, skip the layer, record `"ran": false` with a short `reason`, and tell the user in the final message exactly what to set up (see `references/bbb-map.md`). Do not try to install a BigBlueButton server.

When it can run, follow "Running the runtime layer" in `references/bbb-map.md` with `A11Y_AUDIT_DIR=<abs run dir>/raw/runtime` (about 6 minutes; allow 20). It runs six scenarios (moderator tour, moderator + attendee interactions, guest lobby, pt-BR, dark theme, mobile) and writes one JSON per scenario plus a screenshot of every state. Then:

- Map each axe violation to its criterion via the `wcag…` tag. Group by rule and root cause across states and scenarios (the same rule in many states is usually one finding). Trace selectors to source files.
- Treat `incomplete` and the custom checks (`keyboard.noOutlineOrShadow`, `keyboard.obscured`, `reflow.offenders`, `textSpacing.newlyClipped`, `nonTextContrast`) as candidates: confirm before reporting. Rejected ones go to `discarded`.
- Read `announcements` (what reached live regions, per actor and moment) for 4.1.3 and 4.1.2: a moment with no announcement where one is expected (someone left, a poll started) is a candidate; `regionCreatedWithMessage: true` means the region was inserted with its text and may not be read.
- Look at the screenshots of states with findings (`raw/runtime/shots/`), and attach `shots` to findings (see `references/rubric.md`) so the report shows where each problem is.
- A state with `ok: false` or a check with an error means it was not audited. List it under `meta.notCovered`; do not mark its criteria `pass` because of it.

In `diff` and `path` modes, keep only runtime findings that trace back into the scope.

## 4. Guided review

For criteria marked `V` in `references/criteria.md` that are in scope, read the code of the relevant flows from `references/bbb-map.md`. In `full` mode go through the core flows first, then secondary ones as time allows, and list in the summary which flows were reviewed. Every review finding needs file and line evidence; when you could not confirm behavior without running it, use `"confidence": "likely"` and say what to confirm.

Do not report what you cannot point to. Turn suspicions into screen reader scripts (`references/manual-checks.md`) instead.

## 5. Classify, cover, script

- Classify each finding with `references/rubric.md` (impact, effort, shared, external, key).
- Fill `coverage` for every criterion that is not failing, following the coverage rule in `references/criteria.md`. Be strict: `pass` only when a layer that can decide it actually ran.
- Write 3–6 `manualChecks` for the core flows in scope and for findings that need a person to confirm.
- Fill `meta.summary`, `meta.reviewedFlows` and `meta.notCovered`: they make the "O que foi testado" tab, which tells the reader exactly what was and was not checked.

## 6. Build the report

Write `<run>/raw/findings.input.json` (schema in `references/rubric.md`), then:

```bash
node $SKILL/scripts/build-report.mjs <run>
```

It validates the input (fix and rerun if it complains), assigns stable IDs, computes priority and the EN 301 549 clause, compares with the previous run (new, persisting, regressed, fixed, not re-checked) and writes `<run>/findings.json` and `<run>/report.html`. Open the report for the user (`xdg-open` on Linux, `open` on macOS).

## 7. Tell the user

Keep the chat message short; the report holds the detail:

- verdict and counts per priority, with the change since the last run
- which layers ran, which were skipped and why, which meeting states or flows were not covered
- the P1 findings as one line each (title, criterion, file)
- the report path

Offer to turn findings into tasks (one per finding, P1 first). Do not open issues or PRs unless asked.

**Security:** if a finding could be exploited (for example an authentication bypass found while checking 3.3.8), leave it out of the report and tell the user privately to follow the repository security policy (private advisory, no public issue or PR).
