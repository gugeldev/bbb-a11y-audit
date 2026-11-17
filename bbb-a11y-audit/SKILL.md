---
name: bbb-a11y-audit
description: Audit the BigBlueButton HTML5 client against WCAG 2.2 level A and AA (EN 301 549 clause 9), one topic at a time (a guideline, a principle or a criterion) or the whole client, and produce an HTML report organized by principle, guideline and criterion, where every criterion ends failing, passing or not applicable, with evidence, annotated screenshots, fixes and priorities. Combines a static scan, an axe-core/Playwright run against a live meeting and a guided code review, and compares with the previous run of the same topic. Use when the user asks for an accessibility or WCAG audit, to audit a guideline or criterion, for an a11y report, or to check a component or a branch for accessibility regressions.
---

# Accessibility audit (WCAG 2.2 AA)

Produce an honest list of accessibility problems for the chosen topic that can be turned into small tasks and fixed within the phase. The audit is **read-only**: do not change application code while auditing, even for obvious fixes. Fixing is a separate request.

Skill directory: the folder that contains this SKILL.md (below: `$SKILL`; in this repository usually `.claude/skills/bbb-a11y-audit`). References, read when the step needs them:

- `references/criteria.md`: the 55 criteria, which layer can evaluate each, BBB hotspots, coverage rules
- `references/rubric.md`: impact, effort, this phase or backlog, grouping, stable keys, the `findings.input.json` schema
- `references/static-patterns.md`: static tools, how to triage each pattern, eslint and axe mappings
- `references/bbb-map.md`: flows, code locations, shared components, how to run the runtime layer
- `references/manual-checks.md`: screen reader scripts
- `runtime/`: the Playwright spec and recorder of the runtime layer (installed into the BigBlueButton test suite on first use)

## 1. Scope and mode

The normal way to work is **one topic at a time**: pick a guideline, audit everything in it, fix what was found, audit it again until it is done, then move to the next one. A full audit is the occasional overview used to choose the next topic.

| Invocation | Mode | Scope |
| --- | --- | --- |
| `/bbb-a11y-audit diretriz 2.1` (or `guideline`; several: `diretriz 2.1 2.4`; a whole principle: `principio 2`) | `guideline` | every criterion of the topic, across the whole client and every flow, decided completely. Everything else is left out of the run and of the report. |
| `/bbb-a11y-audit criterio 2.4.7` (or `criterion`) | `criterion` | one or more criteria, same depth |
| `/bbb-a11y-audit` or `full` | `full` | all 55 criteria (overview / map) |
| `/bbb-a11y-audit <path>` | `path` | that folder or file, all criteria |
| `/bbb-a11y-audit diff [base]` | `diff` | files changed vs `git merge-base HEAD <base>` (default base: the repo main branch, `v4.0.x-develop`) under `bigbluebutton-html5/` |
| add `--no-runtime` | | skip the runtime layer |

If the request is ambiguous, pick the closest mode and say which one you used. Do not ask.

Create the run directory at the repo root: `a11y-reports/<YYYY-MM-DD_HHMM>[_<topic>]/raw/`, e.g. `2026-11-20_1430_d2.1` or `2026-11-20_1500_full`. It must start with the date and time: the report compares against older runs **of the same topic** (or, the first time, against the latest full run restricted to the topic). `a11y-reports/` is git-ignored.

In `guideline` and `criterion` modes set `meta.guidelines` / `meta.criteria` in findings.input.json, and in every layer look only at what can inform the topic (each step below says how). Criteria outside the topic are left out automatically.

## 2. Static layer

```bash
node $SKILL/scripts/static-scan.mjs [--guidelines=2.1] <scope paths…> > <run>/raw/static.json
$SKILL/scripts/eslint-a11y.sh <run>/raw/eslint.json <scope paths…>
```

With a topic, pass `--guidelines` to the scan (it keeps only the topic's patterns) and triage only the eslint messages whose rule maps to the topic (`references/static-patterns.md`).

Then triage every candidate as described in `references/static-patterns.md`: open the code, decide, group by root cause. Rejected candidates go to `discarded` with a reason. If a previous run exists, read its `findings.json` `discarded` list and reuse decisions for unchanged code instead of re-reading it.

## 3. Runtime layer

First make sure the runtime files are installed, following "Setting up the runtime layer" in `references/bbb-map.md`: the spec and recorder from `$SKILL/runtime/` must be in the BigBlueButton Playwright suite, and `@axe-core/playwright` in its dependencies. Copying them and installing the package is setup, not a code change to the application; do it when missing or outdated and mention it in the final message.

Then check whether it can run (`bigbluebutton-tests/playwright/.env` has non-empty `BBB_URL` and `BBB_SECRET`, `node_modules` exists, a Chromium is installed). If anything is missing, skip the layer, record `"ran": false` with a short `reason`, and tell the user in the final message exactly what to set up. Do not try to install a BigBlueButton server or edit `.env`.

When it can run, follow "Running the runtime layer" in `references/bbb-map.md` with `A11Y_AUDIT_DIR=<abs run dir>/raw/runtime`, plus `A11Y_GUIDELINES=<topic>` in topic modes (e.g. `2.1`): the spec then skips the checks and scenarios that cannot inform the topic and runs axe only with the topic's rules. Full run: about 8 minutes; a topic is usually faster. Allow 25 minutes. It runs six scenarios (moderator tour, moderator + attendee interactions, guest lobby, pt-BR, dark theme, mobile) and writes one JSON per scenario plus a screenshot of every state. Then:

- Map each axe violation to its criterion via the `wcag…` tag. Group by rule and root cause across states and scenarios (the same rule in many states is usually one finding). Trace selectors to source files.
- Treat `incomplete` and the custom checks (`keyboard.noOutlineOrShadow`, `keyboard.obscured`, `reflow.offenders`, `textSpacing.newlyClipped`, `nonTextContrast`) as candidates: confirm before reporting. Rejected ones go to `discarded`.
- Read `announcements` (what reached live regions, per actor and moment) for 4.1.3 and 4.1.2: a moment with no announcement where one is expected (someone left, a poll started) is a candidate; `regionCreatedWithMessage: true` means the region was inserted with its text and may not be read.
- Look at the screenshots of states with findings (`raw/runtime/shots/`), and attach `shots` to findings (see `references/rubric.md`) so the report shows where each problem is.
- A state with `ok: false` or a check with an error means it was not audited. List it under `meta.notCovered`; do not mark its criteria `pass` because of it.

In `diff` and `path` modes, keep only runtime findings that trace back into the scope.

## 4. Guided review

For criteria marked `V` in `references/criteria.md` that are in scope, read the code of the relevant flows from `references/bbb-map.md` until each criterion is decided. In `full` mode start with the core flows; in `guideline` and `criterion` modes go through every flow in `bbb-map.md` for the criteria in scope. List in `meta.reviewedFlows` what you read. Every review finding needs file and line evidence; when you could not confirm behavior without running it, use `"confidence": "likely"` and say what to confirm.

Do not report what you cannot point to. If something can only be confirmed by a person, write a script (`references/manual-checks.md`); if it can be confirmed by reading more code or the runtime data, do that instead.

## 5. Classify, cover, script

- Classify each finding with `references/rubric.md` (impact, effort, shared, external, key).
- Keep ids stable across runs: read the `findings.json` of the previous run of this topic (or the latest full run) and, for each problem that is still there, reuse its `key`, or set its `id` explicitly. Otherwise it shows up as "new" plus a false "fixed".
- Fill `coverage` for every in-scope criterion that is not failing (and add `method`/`how` to failing ones too), following the coverage rule in `references/criteria.md`: `pass` or `na` with `method` and `how`, `human` only for what truly needs a person (with its script), `not-covered` only when this run could not decide it (with what is missing). The goal is that a guideline can be closed with nothing left open; `build-report.mjs` refuses missing entries.
- Write `manualChecks`: one for every `human` criterion, plus screen-reader confirmations for the core flows in scope (3–6 in total is typical).
- Fill `meta.summary`, `meta.reviewedFlows` and `meta.notCovered`: they make the "O que foi testado" tab, which tells the reader exactly what was and was not checked.

## 6. Build the report

Write `<run>/raw/findings.input.json` (schema in `references/rubric.md`), then:

```bash
node $SKILL/scripts/build-report.mjs <run>
```

It validates the input (fix and rerun if it complains), assigns stable IDs, puts each finding in this phase or backlog, adds the EN 301 549 clause, compares with the previous run (new, persisting, regressed, fixed, not re-checked) and writes `<run>/findings.json` and `<run>/report.html`. Open the report for the user (`xdg-open` on Linux, `open` on macOS).

## 7. Tell the user

Keep the chat message short; the report holds the detail:

- verdict, how many findings are for this phase and how many went to backlog (with why), and the change since the last run
- per guideline: done, how many criteria fail, or what is still open (`human`, `not-covered`)
- which layers ran, which were skipped and why, which meeting states or flows were not covered
- the blocker and high-impact findings as one line each (title, criterion, file)
- the report path

Offer to turn findings into tasks, grouped by guideline (one phase per guideline, one task per finding, plus one task per `human` criterion). Do not open issues or PRs unless asked.

**Security:** if a finding could be exploited (for example an authentication bypass found while checking 3.3.8), leave it out of the report and tell the user privately to follow the repository security policy (private advisory, no public issue or PR).
