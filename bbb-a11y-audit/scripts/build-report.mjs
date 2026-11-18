#!/usr/bin/env node
/**
 * Builds findings.json and report.html for one audit run.
 *
 *   node build-report.mjs <run-dir>
 *
 * Reads  <run-dir>/raw/findings.input.json  (written by the agent, schema in references/rubric.md)
 *        <run-dir>/raw/runtime/             (written by the runtime layer, optional)
 * Writes <run-dir>/findings.json            (enriched: id, phase bucket, EN clause, status vs previous runs)
 *        <run-dir>/report.html              (self-contained report from templates/report.html)
 *
 * The input is validated first and nothing is written while it has problems: every cited file,
 * line and quote must exist, every in-scope criterion must be decided and every checklist item
 * answered. Previous runs are the sibling directories that contain a findings.json; they are
 * compared by name, so run directories must sort chronologically (YYYY-MM-DD_HHMM).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyChecklists, buildCoverage } from './lib/coverage.mjs';
import { verifyEvidence } from './lib/evidence.mjs';
import { byReportOrder, normalizeFindings } from './lib/findings.mjs';
import { compareWithHistory } from './lib/history.mjs';
import { fail, Issues } from './lib/issues.mjs';
import {
  auditedServer,
  axeEvidenceByCriterion,
  createShotResolver,
  loadRuntime,
  summarizeScenarios,
} from './lib/runtime-data.mjs';
import { CRITERIA, criteriaFilter, topicKey } from './lib/wcag.mjs';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(SKILL_DIR, 'templates', 'report.html');
const CHECKLISTS = JSON.parse(readFileSync(join(SKILL_DIR, 'references', 'checklists.json'), 'utf8'));

if (CRITERIA.length !== 55) throw new Error(`criteria list has ${CRITERIA.length} entries, expected 55`);

function readInput(runDir) {
  const inputPath = join(runDir, 'raw', 'findings.input.json');
  if (!existsSync(inputPath)) fail(`missing ${inputPath}`);
  try {
    return JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    return fail(`invalid JSON in ${inputPath}: ${err.message}`);
  }
}

/** Runs a git command in `dir`; returns '' when git fails (for example, outside a repository). */
function gitIn(dir) {
  return (command) => {
    try {
      return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return '';
    }
  };
}

function buildMeta(meta, { git, previous, server }) {
  return {
    project: meta.project || 'BigBlueButton',
    date: new Date().toISOString(),
    branch: git('rev-parse --abbrev-ref HEAD'),
    commit: git('rev-parse --short HEAD'),
    dirty: git('status --porcelain') !== '',
    scope: meta.scope || '',
    scopePaths: meta.scopePaths || [],
    criteria: meta.criteria || null,
    guidelines: meta.guidelines || null,
    mode: meta.mode || 'full',
    layers: meta.layers || [],
    previousRun: previous?.data.meta?.date || null,
    previousRunDir: previous?.name || null,
    previousRunScope: previous ? topicKey(previous.data.meta) : null,
    example: !!meta.example,
    server,
  };
}

/** The report is the template with the data inlined; `<` is escaped so the JSON cannot close the script tag. */
function writeReport(runDir, data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const template = readFileSync(TEMPLATE, 'utf8');
  writeFileSync(
    join(runDir, 'report.html'),
    template.replace('__DATA__', () => json),
  );
}

function printSummary({ runDir, output, runtime, comparison, issues }) {
  const count = (predicate) => output.findings.filter(predicate).length;
  const byStatus = {};
  for (const { status } of Object.values(output.coverage)) byStatus[status] = (byStatus[status] || 0) + 1;
  const { previous, fixed, notRechecked } = comparison;

  for (const warning of issues.warnings) console.warn(`warning: ${warning}`);
  console.log(
    [
      `report: ${join(runDir, 'report.html')}`,
      `findings: ${output.findings.length} (this phase ${count((f) => f.bucket === 'now')}, backlog ${count((f) => f.bucket === 'backlog')})`,
      `coverage: ${Object.entries(byStatus)
        .map(([status, n]) => `${status} ${n}`)
        .join(', ')}`,
      `runtime: ${runtime.scenarios.length} scenarios, ${runtime.states.size} states, ${Object.keys(runtime.shots).length} screenshots embedded`,
      previous
        ? `vs ${previous.name}: ${count((f) => f.status === 'new')} new, ${count((f) => f.status === 'regressed')} regressed, ${fixed.length} fixed, ${notRechecked.length} not re-checked`
        : 'first run: nothing to compare with',
    ].join('\n'),
  );
}

function main() {
  const runDir = resolve(process.argv[2] || fail('usage: node build-report.mjs <run-dir>'));
  const input = readInput(runDir);
  const meta = input.meta || {};
  const git = gitIn(runDir);
  const issues = new Issues();
  const inScope = criteriaFilter(meta);

  // 1. Validate everything the agent wrote, collecting every problem before failing.
  const runtime = loadRuntime(join(runDir, 'raw', 'runtime'));
  const resolveShot = createShotResolver(runtime.states, issues);
  const findings = normalizeFindings(input.findings, { resolveShot, issues });
  const coverage = buildCoverage({ input, findings, inScope, issues });
  verifyEvidence(findings, git('rev-parse --show-toplevel'), issues);
  applyChecklists({ coverage, input, checklists: CHECKLISTS, inScope, issues });
  if (issues.problems.length) fail(`fix findings.input.json:\n  - ${issues.problems.join('\n  - ')}`);

  // 2. Compare with earlier runs of the same topic.
  const comparison = compareWithHistory({ runDir, meta: input.meta, findings, inScope });

  // 3. Write the outputs.
  const output = {
    meta: buildMeta(meta, { git, previous: comparison.previous, server: auditedServer(runtime.scenarios) }),
    notes: {
      summary: meta.summary || '',
      reviewedFlows: meta.reviewedFlows || [],
      notCovered: meta.notCovered || [],
    },
    axeEvidence: axeEvidenceByCriterion(runtime.scenarios),
    scenarios: summarizeScenarios(runtime.scenarios),
    findings: comparison.findings.sort(byReportOrder),
    coverage,
    fixed: comparison.fixed,
    notRechecked: comparison.notRechecked,
    discarded: input.discarded || [],
    manualChecks: input.manualChecks || [],
  };
  writeFileSync(join(runDir, 'findings.json'), `${JSON.stringify(output, null, 2)}\n`);
  writeReport(runDir, { ...output, shots: runtime.shots });
  printSummary({ runDir, output, runtime, comparison, issues });
}

main();
