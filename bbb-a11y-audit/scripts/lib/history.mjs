/**
 * Compares a run with the earlier runs next to it (a11y-reports/<YYYY-MM-DD_HHMM>[_topic]/), so
 * each finding is marked new, persisting or regressed, and old findings that are gone are split
 * into fixed (this run looked again) and not re-checked (this run could not have seen them).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { topicKey } from './wcag.mjs';

// EN 301 549 9.7 findings belong with the visual-presentation topic, 1.4.
const EN_TOPIC_PROXY = '1.4.4';

/** Runs whose directory name sorts before this one (names start with the date and time). */
function earlierRuns(runDir) {
  const reportsDir = dirname(runDir);
  return readdirSync(reportsDir, { withFileTypes: true })
    .filter(
      (dir) =>
        dir.isDirectory() && dir.name < basename(runDir) && existsSync(join(reportsDir, dir.name, 'findings.json')),
    )
    .map((dir) => dir.name)
    .sort()
    .map((name) => ({ name, data: JSON.parse(readFileSync(join(reportsDir, name, 'findings.json'), 'utf8')) }));
}

/**
 * The latest runs of the same topic; a topic with no history of its own is compared with the
 * latest full runs, restricted to the topic. Runs from older skill versions have no topic: "full".
 */
function comparableRuns(runs, meta) {
  const sameTopic = runs.filter((run) => topicKey(run.data.meta) === topicKey(meta));
  return sameTopic.length ? sameTopic : runs.filter((run) => topicKey(run.data.meta) === 'full');
}

function statusOf(id, previousIds, olderIds, hasPrevious) {
  if (!hasPrevious) return 'new';
  if (previousIds.has(id)) return 'persisting';
  if (olderIds.has(id)) return 'regressed';
  return 'new';
}

/**
 * A finding that disappeared counts as fixed only if this run looked at it again: the layer that
 * found it ran, and its file and criterion are inside this run's scope.
 */
function recheckFilter(meta, inScope) {
  const layersRan = new Set((meta.layers || []).filter((layer) => layer.ran).map((layer) => layer.id));
  const scopePaths = meta.scopePaths || [];
  return (finding) =>
    layersRan.has(finding.source) &&
    (!scopePaths.length || scopePaths.some((path) => finding.location.file.startsWith(path))) &&
    (finding.standard === 'EN' || inScope(finding.criterion));
}

export function compareWithHistory({ runDir, meta = {}, findings, inScope }) {
  const inTopic = (finding) => inScope(finding.standard === 'EN' ? EN_TOPIC_PROXY : finding.criterion);
  const history = comparableRuns(earlierRuns(runDir), meta);
  const previous = history.at(-1);

  const previousFindings = (previous?.data.findings || []).filter(inTopic);
  const previousIds = new Set(previousFindings.map((f) => f.id));
  const olderIds = new Set(
    history.slice(0, -1).flatMap((run) => (run.data.findings || []).filter(inTopic).map((f) => f.id)),
  );

  const withStatus = findings.map((finding) => ({
    ...finding,
    status: statusOf(finding.id, previousIds, olderIds, !!previous),
  }));

  const currentIds = new Set(findings.map((f) => f.id));
  const wasRechecked = recheckFilter(meta, inScope);
  const fixed = [];
  const notRechecked = [];
  for (const finding of previousFindings) {
    if (currentIds.has(finding.id)) continue;
    const summary = { id: finding.id, title: finding.title, criterion: finding.criterion };
    (wasRechecked(finding) ? fixed : notRechecked).push(summary);
  }

  return { previous, findings: withStatus, fixed, notRechecked };
}
