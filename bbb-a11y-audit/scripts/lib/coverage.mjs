/**
 * Coverage: every criterion in the run's topic must end decided (references/criteria.md,
 * "Coverage rule"). Failing criteria come from the findings; the agent states the rest.
 */
import { CRITERIA, isWcagCriterion } from './wcag.mjs';

const STATUSES = ['pass', 'na', 'human', 'not-covered', 'skip'];
const METHODS = ['tool', 'agent', 'human'];

/** `"manual"` was the old name of "not-covered"; a bare string is shorthand for `{ status }`. */
function readEntry(entry) {
  if (typeof entry === 'string') return { status: entry === 'manual' ? 'not-covered' : entry };
  return entry;
}

function validateEntry(criterion, entry, manualFlows, issues) {
  const { status, method, how, check } = entry;
  const where = `coverage ${criterion}`;
  if (!STATUSES.includes(status)) issues.problem(`${where}: status "${status}" must be one of ${STATUSES.join(', ')}`);
  if (['pass', 'na'].includes(status) && (!METHODS.includes(method) || !how)) {
    issues.problem(`${where}: "${status}" needs "method" (${METHODS.join(', ')}) and "how"`);
  }
  if (status === 'human' && (!how || !check)) {
    issues.problem(`${where}: "human" needs "how" and "check" (a manualChecks flow)`);
  }
  if (status === 'human' && check && !manualFlows.has(check)) {
    issues.problem(`${where}: check "${check}" is not a manualChecks flow`);
  }
  if (status === 'not-covered' && !how) issues.problem(`${where}: "not-covered" needs "how" (what is missing)`);
}

/**
 * One entry per criterion. Failing ones may still carry `method` and `how` (how they were checked);
 * criteria outside the topic are `skip`; every other one must be stated in the input.
 */
export function buildCoverage({ input, findings, inScope, issues }) {
  const failing = new Set(findings.filter((f) => f.standard !== 'EN').map((f) => f.criterion));
  const manualFlows = new Set((input.manualChecks || []).map((check) => check.flow));
  const stated = input.coverage || {};

  const coverage = {};
  for (const criterion of CRITERIA) {
    const entry = readEntry(stated[criterion]);
    if (failing.has(criterion)) {
      coverage[criterion] = { status: 'fail', method: entry?.method || '', how: entry?.how || '' };
    } else if (!inScope(criterion)) {
      coverage[criterion] = { status: 'skip' };
    } else if (!entry) {
      issues.problem(`coverage ${criterion}: missing (every in-scope criterion needs pass, na, human or not-covered)`);
    } else {
      validateEntry(criterion, entry, manualFlows, issues);
      coverage[criterion] = {
        status: entry.status,
        method: entry.method || (entry.status === 'human' ? 'human' : ''),
        how: entry.how || '',
        check: entry.check || '',
      };
    }
  }
  return coverage;
}

/**
 * Checklists (references/checklists.json) are the floor every run must cover: each item of an
 * in-scope criterion needs a result and evidence, plus a note on what was explored beyond them.
 * The answered checklist is copied into the coverage entry for the report.
 */
export function applyChecklists({ coverage, input, checklists, inScope, issues }) {
  for (const [criterion, items] of Object.entries(checklists)) {
    if (!isWcagCriterion(criterion) || !inScope(criterion) || coverage[criterion]?.status === 'skip') continue;

    const entry = (input.coverage || {})[criterion] || {};
    const answers = new Map((entry.checklist || []).map((answer) => [answer.id, answer]));
    for (const item of items) {
      const answer = answers.get(item.id);
      if (!answer) {
        issues.problem(`coverage ${criterion}: checklist item ${item.id} not answered ("${item.text}")`);
      } else if (!['pass', 'fail', 'na'].includes(answer.result) || !answer.evidence) {
        issues.problem(
          `coverage ${criterion}: checklist item ${item.id} needs "result" (pass, fail, na) and "evidence"`,
        );
      }
    }
    if (!entry.explored) {
      issues.problem(`coverage ${criterion}: "explored" is required (what you looked for beyond the checklist)`);
    }

    if (coverage[criterion]) {
      coverage[criterion].checklist = items.map((item) => ({ ...item, ...(answers.get(item.id) || {}) }));
      coverage[criterion].explored = entry.explored || '';
    }
  }
}
