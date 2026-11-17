#!/usr/bin/env node
/**
 * Builds findings.json and report.html for one audit run.
 *
 *   node build-report.mjs <run-dir>
 *
 * Reads  <run-dir>/raw/findings.input.json  (written by the agent, schema in references/rubric.md)
 * Writes <run-dir>/findings.json            (enriched: id, phase bucket, EN clause, status vs previous runs)
 *        <run-dir>/report.html              (self-contained report from templates/report.html)
 *
 * Previous runs are the sibling directories of <run-dir> that contain a findings.json; they are
 * compared by name, so run directories must be named so they sort chronologically (YYYY-MM-DD_HHMM).
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', 'templates', 'report.html');
const CHECKLISTS = JSON.parse(readFileSync(join(HERE, '..', 'references', 'checklists.json'), 'utf8'));

const IMPACTS = ['blocker', 'high', 'medium', 'low'];
const EFFORTS = ['S', 'M', 'L'];
const SOURCES = ['static', 'runtime', 'review'];
const WCAG = new Set(
  (
    '1.1.1 1.2.1 1.2.2 1.2.3 1.2.4 1.2.5 1.3.1 1.3.2 1.3.3 1.3.4 1.3.5 1.4.1 1.4.2 1.4.3 1.4.4 1.4.5 1.4.10 1.4.11 1.4.12 1.4.13 ' +
    '2.1.1 2.1.2 2.1.4 2.2.1 2.2.2 2.3.1 2.4.1 2.4.2 2.4.3 2.4.4 2.4.5 2.4.6 2.4.7 2.4.11 2.5.1 2.5.2 2.5.3 2.5.4 2.5.7 2.5.8 ' +
    '3.1.1 3.1.2 3.2.1 3.2.2 3.2.3 3.2.4 3.2.6 3.3.1 3.3.2 3.3.3 3.3.4 3.3.7 3.3.8 4.1.2 4.1.3'
  ).split(' '),
);
if (WCAG.size !== 55) throw new Error(`criteria list has ${WCAG.size} entries, expected 55`);

function fail(msg) {
  console.error(`build-report: ${msg}`);
  process.exit(1);
}

const runDir = resolve(process.argv[2] || fail('usage: node build-report.mjs <run-dir>'));
const inputPath = join(runDir, 'raw', 'findings.input.json');
if (!existsSync(inputPath)) fail(`missing ${inputPath}`);

let input;
try {
  input = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (err) {
  fail(`invalid JSON in ${inputPath}: ${err.message}`);
}

const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: runDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

const problems = [];
const warnings = [];

// ---------- Runtime scenarios and screenshots ----------
// wcagAudit.spec.ts writes one JSON per scenario plus shots/ into raw/runtime (A11Y_AUDIT_DIR).
const SCENARIO_ORDER = ['moderator', 'interactions', 'guest', 'locale-pt-br', 'dark-theme', 'mobile'];
const runtimeDir = join(runDir, 'raw', 'runtime');
const scenarios = existsSync(runtimeDir)
  ? readdirSync(runtimeDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(runtimeDir, n), 'utf8')))
      .sort((a, b) => {
        const ia = SCENARIO_ORDER.indexOf(a.id);
        const ib = SCENARIO_ORDER.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.id).localeCompare(String(b.id));
      })
  : [];
const stateIndex = new Map();
const shots = {};
for (const s of scenarios) {
  for (const st of s.states || []) {
    const key = `${s.id}/${st.id}`;
    stateIndex.set(key, st);
    if (st.shot && existsSync(join(runtimeDir, st.shot))) {
      shots[key] = `data:image/jpeg;base64,${readFileSync(join(runtimeDir, st.shot)).toString('base64')}`;
    }
  }
}

/**
 * A finding points at screenshots with {state, rule?, target?, dataTest?, boxes?, caption?}.
 * Boxes are resolved from the runtime data so the agent never measures pixels by hand.
 */
function resolveShot(ref, where) {
  const st = stateIndex.get(ref.state);
  if (!st) {
    problems.push(`${where}: shots[].state "${ref.state}" does not exist (use "<scenario>/<state>" from raw/runtime/*.json)`);
    return null;
  }
  const boxes = [...(ref.boxes || [])];
  if (ref.rule) {
    const nodes = [...(st.violations || []), ...(st.incomplete || [])]
      .filter((r) => r.id === ref.rule)
      .flatMap((r) => r.nodes)
      .filter((n) => n.box && (!ref.target || n.target.includes(ref.target)));
    if (!nodes.length) warnings.push(`${where}: no on-screen node for rule "${ref.rule}" in ${ref.state}`);
    boxes.push(...nodes.map((n) => n.box));
  }
  for (const dt of [].concat(ref.dataTest || [])) {
    if (st.elements?.[dt]) boxes.push(st.elements[dt]);
    else warnings.push(`${where}: data-test "${dt}" not visible in ${ref.state}`);
  }
  const unique = [...new Map(boxes.map((b) => [`${b.x},${b.y},${b.w},${b.h}`, b])).values()];
  return { shot: ref.state, caption: ref.caption || '', boxes: unique, viewport: st.viewport || null };
}

// ---------- Validate and enrich findings ----------
const findings = (input.findings || []).map((f, i) => {
  const where = `findings[${i}] "${f.title || '?'}"`;
  if (!f.title) problems.push(`${where}: missing title`);
  if (!f.criterion) problems.push(`${where}: missing criterion`);
  if (f.criterion && !WCAG.has(f.criterion) && f.standard !== 'EN') {
    problems.push(`${where}: criterion ${f.criterion} is not a WCAG 2.2 A/AA criterion (set "standard": "EN" for EN 301 549 clauses)`);
  }
  if (!IMPACTS.includes(f.impact)) problems.push(`${where}: impact must be one of ${IMPACTS.join(', ')}`);
  if (!EFFORTS.includes(f.effort)) problems.push(`${where}: effort must be one of ${EFFORTS.join(', ')}`);
  if (!SOURCES.includes(f.source)) problems.push(`${where}: source must be one of ${SOURCES.join(', ')}`);
  if (!f.location || !f.location.file) problems.push(`${where}: missing location.file`);

  const location = { file: '', line: 0, selector: '', state: '', ...(f.location || {}) };
  // Everything in the topic is fixed in this phase, except what cannot be done inside it.
  const backlog = f.backlog !== undefined ? !!f.backlog : f.effort === 'L' || !!f.external;
  const backlogReason =
    f.backlogReason || (backlog ? (f.external ? 'Depende de uma biblioteca externa.' : 'Esforço grande: precisa de planejamento próprio.') : '');
  if (f.backlog === true && !f.backlogReason) problems.push(`${where}: "backlog": true needs "backlogReason"`);
  const key = f.key || `${f.source}:${location.selector || location.line || ''}`;
  const id = f.id || `A11Y-${createHash('sha1').update(`${f.criterion}|${location.file}|${key}`).digest('hex').slice(0, 6)}`;
  return {
    id,
    key,
    title: f.title,
    criterion: f.criterion,
    standard: f.standard || 'WCAG',
    criterionName: f.criterionName || '',
    impact: f.impact,
    effort: f.effort,
    bucket: backlog ? 'backlog' : 'now',
    backlogReason,
    source: f.source,
    confidence: f.confidence || 'confirmed',
    location,
    relatedLocations: (f.relatedLocations || []).map((l) => ({ file: '', line: 0, ...l })),
    occurrences: f.occurrences || 1,
    shared: !!f.shared,
    external: !!f.external,
    evidence: f.evidence || '',
    affects: f.affects || '',
    fix: f.fix || '',
    verify: f.verify || '',
    en: f.standard === 'EN' ? f.criterion : `9.${f.criterion}`,
    quote: f.quote || '',
    evidenceShots: (f.shots || []).map((ref) => resolveShot(ref, where)).filter(Boolean),
  };
});

const seen = new Map();
for (const f of findings) {
  if (seen.has(f.id)) problems.push(`duplicate id ${f.id} ("${seen.get(f.id)}" and "${f.title}"): merge them or give them different keys`);
  seen.set(f.id, f.title);
}
// ---------- Coverage: every in-scope criterion must end decided ----------
const STATUSES = ['pass', 'na', 'human', 'not-covered', 'skip'];
const METHODS = ['tool', 'agent', 'human'];
const metaIn = input.meta || {};
const inCriteriaScope = (c) =>
  (!metaIn.criteria || metaIn.criteria.includes(c)) &&
  (!metaIn.guidelines || metaIn.guidelines.some((g) => c.startsWith(`${g}.`)));
const failing = new Set(findings.filter((f) => f.standard !== 'EN').map((f) => f.criterion));
const manualFlows = new Set((input.manualChecks || []).map((m) => m.flow));
const coverage = {};
for (const c of WCAG) {
  if (failing.has(c)) {
    // Failing comes from findings; method/how may still be given to say how it was checked.
    const o = (input.coverage || {})[c];
    coverage[c] = { status: 'fail', method: (o && o.method) || '', how: (o && o.how) || '' };
  } else if (!inCriteriaScope(c)) {
    coverage[c] = { status: 'skip' };
  } else {
    let o = (input.coverage || {})[c];
    if (typeof o === 'string') o = { status: o === 'manual' ? 'not-covered' : o };
    if (!o) {
      problems.push(`coverage ${c}: missing (every in-scope criterion needs pass, na, human or not-covered)`);
    } else {
      if (!STATUSES.includes(o.status)) problems.push(`coverage ${c}: status "${o.status}" must be one of ${STATUSES.join(', ')}`);
      if (['pass', 'na'].includes(o.status) && (!METHODS.includes(o.method) || !o.how)) {
        problems.push(`coverage ${c}: "${o.status}" needs "method" (${METHODS.join(', ')}) and "how"`);
      }
      if (o.status === 'human' && (!o.how || !o.check)) problems.push(`coverage ${c}: "human" needs "how" and "check" (a manualChecks flow)`);
      if (o.status === 'human' && o.check && !manualFlows.has(o.check)) problems.push(`coverage ${c}: check "${o.check}" is not a manualChecks flow`);
      if (o.status === 'not-covered' && !o.how) problems.push(`coverage ${c}: "not-covered" needs "how" (what is missing)`);
      coverage[c] = { status: o.status, method: o.method || (o.status === 'human' ? 'human' : ''), how: o.how || '', check: o.check || '' };
    }
  }
}

// ---------- Evidence must exist (anti-hallucination) ----------
const repoRoot = git('rev-parse --show-toplevel');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const fileLines = new Map();
const readLines = (file) => {
  if (!fileLines.has(file)) {
    const abs = join(repoRoot, file);
    fileLines.set(file, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n') : null);
  }
  return fileLines.get(file);
};
if (!repoRoot) warnings.push('not inside a git repository: file, line and quote checks were skipped');
for (const f of findings) {
  if (!repoRoot) break;
  const where = `finding "${f.title}"`;
  for (const loc of [f.location, ...f.relatedLocations]) {
    if (!loc.file) continue;
    const lines = readLines(loc.file);
    if (!lines) {
      problems.push(`${where}: file "${loc.file}" does not exist (paths are repo-relative)`);
    } else if (loc.line && (loc.line < 1 || loc.line > lines.length)) {
      problems.push(`${where}: ${loc.file} has ${lines.length} lines, line ${loc.line} does not exist`);
    }
  }
  const lines = f.location.file ? readLines(f.location.file) : null;
  if (lines && f.quote) {
    const from = f.location.line ? Math.max(0, f.location.line - 6) : 0;
    const to = f.location.line ? Math.min(lines.length, f.location.line + 5) : lines.length;
    if (!norm(lines.slice(from, to).join(' ')).includes(norm(f.quote))) {
      problems.push(`${where}: "quote" is not found in ${f.location.file}${f.location.line ? ` around line ${f.location.line}` : ''}`);
    }
  } else if (lines && (f.source === 'static' || f.source === 'review') && f.location.line) {
    problems.push(`${where}: static and review findings need "quote" (the exact code at location.line)`);
  }
}

// ---------- Checklists: the floor every run must cover ----------
for (const [c, items] of Object.entries(CHECKLISTS)) {
  if (!WCAG.has(c) || !inCriteriaScope(c) || coverage[c]?.status === 'skip') continue;
  const entry = (input.coverage || {})[c] || {};
  const answered = new Map((entry.checklist || []).map((x) => [x.id, x]));
  for (const item of items) {
    const a = answered.get(item.id);
    if (!a) problems.push(`coverage ${c}: checklist item ${item.id} not answered ("${item.text}")`);
    else if (!['pass', 'fail', 'na'].includes(a.result) || !a.evidence) {
      problems.push(`coverage ${c}: checklist item ${item.id} needs "result" (pass, fail, na) and "evidence"`);
    }
  }
  if (!entry.explored) problems.push(`coverage ${c}: "explored" is required (what you looked for beyond the checklist)`);
  if (coverage[c]) {
    coverage[c].checklist = items.map((item) => ({ ...item, ...(answered.get(item.id) || {}) }));
    coverage[c].explored = entry.explored || '';
  }
}

if (problems.length) fail(`fix findings.input.json:\n  - ${problems.join('\n  - ')}`);

// ---------- Compare with previous runs ----------
const reportsDir = dirname(runDir);
const previousRuns = readdirSync(reportsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name < basename(runDir) && existsSync(join(reportsDir, d.name, 'findings.json')))
  .map((d) => d.name)
  .sort()
  .map((name) => ({ name, data: JSON.parse(readFileSync(join(reportsDir, name, 'findings.json'), 'utf8')) }));

// Compare with the latest run of the same topic; a topic run with no history compares with the
// latest full run, restricted to the topic. Runs from older skill versions have no topic: "full".
const scopeKey = (m) => {
  if (m?.guidelines?.length) return `g:${[...m.guidelines].sort().join(',')}`;
  if (m?.criteria?.length) return `c:${[...m.criteria].sort().join(',')}`;
  return 'full';
};
const myScope = scopeKey(input.meta);
const sameScope = previousRuns.filter((r) => scopeKey(r.data.meta) === myScope);
const history = sameScope.length ? sameScope : previousRuns.filter((r) => scopeKey(r.data.meta) === 'full');
const inTopic = (f) => (f.standard === 'EN' ? inCriteriaScope('1.4.4') : inCriteriaScope(f.criterion));
const prev = history.at(-1);
const prevFindings = (prev?.data.findings || []).filter(inTopic);
const prevIds = new Set(prevFindings.map((f) => f.id));
const olderIds = new Set(history.slice(0, -1).flatMap((r) => (r.data.findings || []).filter(inTopic).map((f) => f.id)));

for (const f of findings) {
  if (!prev) f.status = 'new';
  else if (prevIds.has(f.id)) f.status = 'persisting';
  else if (olderIds.has(f.id)) f.status = 'regressed';
  else f.status = 'new';
}

// A previous finding counts as fixed only if this run looked at it again: same layer ran, and
// the file and criterion are inside this run's scope. Otherwise it is carried as "not re-checked".
const meta = input.meta || {};
const layersRan = new Set((meta.layers || []).filter((l) => l.ran).map((l) => l.id));
const scopePaths = meta.scopePaths || [];
const criteriaScope = meta.criteria || null;
const inScope = (f) =>
  layersRan.has(f.source) &&
  (!scopePaths.length || scopePaths.some((p) => f.location.file.startsWith(p))) &&
  (f.standard === 'EN' || inCriteriaScope(f.criterion));
const currentIds = new Set(findings.map((f) => f.id));
const fixed = [];
const notRechecked = [];
for (const f of prevFindings) {
  if (currentIds.has(f.id)) continue;
  (inScope(f) ? fixed : notRechecked).push({ id: f.id, title: f.title, criterion: f.criterion });
}

// ---------- Write outputs ----------
const output = {
  meta: {
    project: meta.project || 'BigBlueButton',
    date: new Date().toISOString(),
    branch: git('rev-parse --abbrev-ref HEAD'),
    commit: git('rev-parse --short HEAD'),
    dirty: git('status --porcelain') !== '',
    scope: meta.scope || '',
    scopePaths,
    criteria: criteriaScope,
    guidelines: meta.guidelines || null,
    mode: meta.mode || 'full',
    layers: meta.layers || [],
    previousRun: prev?.data.meta?.date || null,
    previousRunDir: prev?.name || null,
    previousRunScope: prev ? scopeKey(prev.data.meta) : null,
    example: !!meta.example,
    server: (() => {
      const s = (scenarios.find((x) => x.checks?.server) || {}).checks?.server;
      if (!s) return null;
      // Development builds leave the version placeholders unfilled.
      const clean = (v) => (v && !/^HTML5_[A-Z_]+$/.test(v) ? v : null);
      return { url: s.url, bbbServerVersion: clean(s.bbbServerVersion), html5ClientBuild: clean(s.html5ClientBuild) };
    })(),
  },
  notes: {
    summary: meta.summary || '',
    reviewedFlows: meta.reviewedFlows || [],
    notCovered: meta.notCovered || [],
  },
  axeEvidence: (() => {
    // Per criterion: which axe rules ran (passed or failed) and in how many screens.
    const ev = {};
    for (const s of scenarios) {
      for (const st of s.states || []) {
        if (!st.ok) continue;
        const seen = new Set();
        const add = (rule, kind) => {
          for (const tag of rule.tags || []) {
            const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
            if (!m) continue;
            const c = `${m[1]}.${m[2]}.${m[3]}`;
            if (!WCAG.has(c)) continue;
            ev[c] = ev[c] || { screens: 0, rules: {} };
            const r = (ev[c].rules[rule.id] = ev[c].rules[rule.id] || { help: rule.help, passed: 0, failed: 0 });
            r[kind] += 1;
            if (!seen.has(c)) {
              seen.add(c);
              ev[c].screens += 1;
            }
          }
        };
        (st.passes || []).forEach((r) => add(r, 'passed'));
        (st.violations || []).forEach((r) => add(r, 'failed'));
      }
    }
    return ev;
  })(),
  scenarios: scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    actors: s.actors || [],
    announcements: s.announcements || [],
    checks: Object.entries(s.checks || {}).map(([id, v]) => {
      const error = (v && typeof v === 'object' && v.error) || (id.endsWith('Error') ? String(v) : '');
      return { id, ok: !error, error: error ? String(error).slice(0, 300) : '' };
    }),
    states: (s.states || []).map((st) => ({
      key: `${s.id}/${st.id}`,
      id: st.id,
      name: st.name,
      description: st.description,
      actor: st.actor,
      ok: st.ok,
      error: st.error || '',
      violations: (st.violations || []).length,
      incomplete: (st.incomplete || []).length,
      viewport: st.viewport || null,
      lang: st.lang || '',
    })),
  })),
  findings: findings.sort(
    (a, b) =>
      (a.bucket === b.bucket ? 0 : a.bucket === 'now' ? -1 : 1) ||
      IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) ||
      EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort),
  ),
  coverage,
  fixed,
  notRechecked,
  discarded: input.discarded || [],
  manualChecks: input.manualChecks || [],
};

writeFileSync(join(runDir, 'findings.json'), `${JSON.stringify(output, null, 2)}\n`);

const template = readFileSync(TEMPLATE, 'utf8');
const safeJson = JSON.stringify({ ...output, shots }).replace(/</g, '\\u003c');
writeFileSync(join(runDir, 'report.html'), template.replace('__DATA__', () => safeJson));

// ---------- Summary for the agent ----------
const count = (fn) => output.findings.filter(fn).length;
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(
  [
    `report: ${join(runDir, 'report.html')}`,
    `findings: ${output.findings.length} (this phase ${count((f) => f.bucket === 'now')}, backlog ${count((f) => f.bucket === 'backlog')})`,
    `coverage: ${Object.entries(
      Object.values(coverage).reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] || 0) + 1 }), {}),
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    `runtime: ${scenarios.length} scenarios, ${stateIndex.size} states, ${Object.keys(shots).length} screenshots embedded`,
    prev
      ? `vs ${prev.name}: ${count((f) => f.status === 'new')} new, ${count((f) => f.status === 'regressed')} regressed, ${fixed.length} fixed, ${notRechecked.length} not re-checked`
      : 'first run: nothing to compare with',
  ].join('\n'),
);
