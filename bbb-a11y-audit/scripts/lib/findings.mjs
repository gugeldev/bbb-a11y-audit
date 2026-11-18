/**
 * Validates the findings the agent wrote and turns them into report findings: stable id, phase
 * bucket (this phase or backlog), EN 301 549 clause and resolved screenshot markers.
 * The input schema is documented in references/rubric.md.
 */
import { createHash } from 'node:crypto';

import { enClause, isWcagCriterion } from './wcag.mjs';

export const IMPACTS = ['blocker', 'high', 'medium', 'low'];
export const EFFORTS = ['S', 'M', 'L'];
export const SOURCES = ['static', 'runtime', 'review'];

const BACKLOG_REASON = {
  external: 'Depende de uma biblioteca externa.',
  large: 'Esforço grande: precisa de planejamento próprio.',
};

function validate(finding, where, issues) {
  const { title, criterion, standard, impact, effort, source, location } = finding;
  if (!title) issues.problem(`${where}: missing title`);
  if (!criterion) issues.problem(`${where}: missing criterion`);
  if (criterion && !isWcagCriterion(criterion) && standard !== 'EN') {
    issues.problem(
      `${where}: criterion ${criterion} is not a WCAG 2.2 A/AA criterion (set "standard": "EN" for EN 301 549 clauses)`,
    );
  }
  if (!IMPACTS.includes(impact)) issues.problem(`${where}: impact must be one of ${IMPACTS.join(', ')}`);
  if (!EFFORTS.includes(effort)) issues.problem(`${where}: effort must be one of ${EFFORTS.join(', ')}`);
  if (!SOURCES.includes(source)) issues.problem(`${where}: source must be one of ${SOURCES.join(', ')}`);
  if (!location?.file) issues.problem(`${where}: missing location.file`);
}

/**
 * Everything in the topic is fixed in this phase, except what cannot be done inside it: work that
 * depends on an external library or a large effort. The agent can override that with `backlog`.
 */
function phaseOf(finding, where, issues) {
  const backlog = finding.backlog !== undefined ? !!finding.backlog : finding.effort === 'L' || !!finding.external;
  if (finding.backlog === true && !finding.backlogReason)
    issues.problem(`${where}: "backlog": true needs "backlogReason"`);

  const defaultReason = finding.external ? BACKLOG_REASON.external : BACKLOG_REASON.large;
  return {
    bucket: backlog ? 'backlog' : 'now',
    backlogReason: finding.backlogReason || (backlog ? defaultReason : ''),
  };
}

/**
 * The id must survive unrelated edits, so it hashes the criterion, the file and the `key` the agent
 * keeps between runs, never the line number. An explicit `id` wins (to keep continuity on a move).
 */
function stableId(finding, location, key) {
  if (finding.id) return finding.id;
  const hash = createHash('sha1').update(`${finding.criterion}|${location.file}|${key}`).digest('hex');
  return `A11Y-${hash.slice(0, 6)}`;
}

function normalize(finding, index, { resolveShot, issues }) {
  const where = `findings[${index}] "${finding.title || '?'}"`;
  validate(finding, where, issues);

  const location = { file: '', line: 0, selector: '', state: '', ...(finding.location || {}) };
  const { bucket, backlogReason } = phaseOf(finding, where, issues);
  const key = finding.key || `${finding.source}:${location.selector || location.line || ''}`;

  return {
    id: stableId(finding, location, key),
    key,
    title: finding.title,
    criterion: finding.criterion,
    standard: finding.standard || 'WCAG',
    criterionName: finding.criterionName || '',
    impact: finding.impact,
    effort: finding.effort,
    bucket,
    backlogReason,
    source: finding.source,
    confidence: finding.confidence || 'confirmed',
    location,
    relatedLocations: (finding.relatedLocations || []).map((related) => ({ file: '', line: 0, ...related })),
    occurrences: finding.occurrences || 1,
    shared: !!finding.shared,
    external: !!finding.external,
    evidence: finding.evidence || '',
    affects: finding.affects || '',
    fix: finding.fix || '',
    verify: finding.verify || '',
    en: enClause(finding.criterion, finding.standard),
    quote: finding.quote || '',
    evidenceShots: (finding.shots || []).map((ref) => resolveShot(ref, where)).filter(Boolean),
  };
}

function checkUniqueIds(findings, issues) {
  const titleById = new Map();
  for (const { id, title } of findings) {
    if (titleById.has(id)) {
      issues.problem(
        `duplicate id ${id} ("${titleById.get(id)}" and "${title}"): merge them or give them different keys`,
      );
    }
    titleById.set(id, title);
  }
}

export function normalizeFindings(rawFindings = [], context) {
  const findings = rawFindings.map((finding, index) => normalize(finding, index, context));
  checkUniqueIds(findings, context.issues);
  return findings;
}

/** Report order: this phase before backlog, then by impact, then cheapest first. */
export function byReportOrder(a, b) {
  return (
    (a.bucket === b.bucket ? 0 : a.bucket === 'now' ? -1 : 1) ||
    IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) ||
    EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort)
  );
}
