/**
 * Reads the output of the runtime layer (raw/runtime/*.json and raw/runtime/shots/, written by
 * wcagAudit.spec.ts) and turns it into what the report needs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isWcagCriterion } from './wcag.mjs';

const SCENARIO_ORDER = ['moderator', 'interactions', 'breakout', 'guest', 'locale-pt-br', 'dark-theme', 'mobile'];
const MAX_CHECK_ERROR = 300;

// axe tags carry the criterion they test: wcag143 is 1.4.3, wcag1410 is 1.4.10.
const AXE_CRITERION_TAG = /^wcag(\d)(\d)(\d+)$/;

/** Development builds of the client leave the version placeholders unfilled. */
const filledVersion = (value) => (value && !/^HTML5_[A-Z_]+$/.test(value) ? value : null);

function scenarioRank(id) {
  const index = SCENARIO_ORDER.indexOf(id);
  return index < 0 ? Infinity : index;
}

function byScenarioOrder(a, b) {
  return scenarioRank(a.id) - scenarioRank(b.id) || String(a.id).localeCompare(String(b.id));
}

/**
 * Loads every scenario of the run, in a fixed order, and indexes its states by "<scenario>/<state>".
 * Screenshots are embedded as data URIs so the report is a single self-contained file.
 */
export function loadRuntime(runtimeDir) {
  const scenarios = existsSync(runtimeDir)
    ? readdirSync(runtimeDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(runtimeDir, name), 'utf8')))
        .sort(byScenarioOrder)
    : [];

  const states = new Map();
  const shots = {};
  for (const scenario of scenarios) {
    for (const state of scenario.states || []) {
      const key = `${scenario.id}/${state.id}`;
      states.set(key, state);
      const shotPath = state.shot && join(runtimeDir, state.shot);
      if (shotPath && existsSync(shotPath)) {
        shots[key] = `data:image/jpeg;base64,${readFileSync(shotPath).toString('base64')}`;
      }
    }
  }
  return { scenarios, states, shots };
}

/**
 * A finding points at screenshots with `{ state, rule?, target?, dataTest?, boxes?, caption? }`.
 * The boxes to draw are measured from the runtime data, so the agent never measures pixels by hand:
 * `rule` marks every on-screen node of that axe rule, `dataTest` marks those elements.
 */
export function createShotResolver(states, issues) {
  return function resolveShot(ref, where) {
    const state = states.get(ref.state);
    if (!state) {
      issues.problem(
        `${where}: shots[].state "${ref.state}" does not exist (use "<scenario>/<state>" from raw/runtime/*.json)`,
      );
      return null;
    }

    const boxes = [...(ref.boxes || [])];
    if (ref.rule) {
      const nodes = [...(state.violations || []), ...(state.incomplete || [])]
        .filter((rule) => rule.id === ref.rule)
        .flatMap((rule) => rule.nodes)
        .filter((node) => node.box && (!ref.target || node.target.includes(ref.target)));
      if (!nodes.length) issues.warn(`${where}: no on-screen node for rule "${ref.rule}" in ${ref.state}`);
      boxes.push(...nodes.map((node) => node.box));
    }
    for (const dataTest of [].concat(ref.dataTest || [])) {
      if (state.elements?.[dataTest]) boxes.push(state.elements[dataTest]);
      else issues.warn(`${where}: data-test "${dataTest}" not visible in ${ref.state}`);
    }

    const unique = [...new Map(boxes.map((box) => [`${box.x},${box.y},${box.w},${box.h}`, box])).values()];
    return { shot: ref.state, caption: ref.caption || '', boxes: unique, viewport: state.viewport || null };
  };
}

/** The server and client build that were audited, as recorded by the moderator scenario. */
export function auditedServer(scenarios) {
  const server = scenarios.find((scenario) => scenario.checks?.server)?.checks.server;
  if (!server) return null;
  return {
    url: server.url,
    bbbServerVersion: filledVersion(server.bbbServerVersion),
    html5ClientBuild: filledVersion(server.html5ClientBuild),
  };
}

/** Per criterion: which axe rules ran on it (passed or failed), and on how many screens. */
export function axeEvidenceByCriterion(scenarios) {
  const evidence = {};
  for (const scenario of scenarios) {
    for (const state of scenario.states || []) {
      if (!state.ok) continue;
      const countedScreen = new Set();
      const record = (rule, outcome) => {
        for (const tag of rule.tags || []) {
          const match = AXE_CRITERION_TAG.exec(tag);
          if (!match) continue;
          const criterion = `${match[1]}.${match[2]}.${match[3]}`;
          if (!isWcagCriterion(criterion)) continue;

          evidence[criterion] ||= { screens: 0, rules: {} };
          const ruleEvidence = (evidence[criterion].rules[rule.id] ||= { help: rule.help, passed: 0, failed: 0 });
          ruleEvidence[outcome] += 1;
          if (!countedScreen.has(criterion)) {
            countedScreen.add(criterion);
            evidence[criterion].screens += 1;
          }
        }
      };
      (state.passes || []).forEach((rule) => record(rule, 'passed'));
      (state.violations || []).forEach((rule) => record(rule, 'failed'));
    }
  }
  return evidence;
}

function summarizeCheck([id, value]) {
  const error = (value && typeof value === 'object' && value.error) || (id.endsWith('Error') ? String(value) : '');
  return { id, ok: !error, error: error ? String(error).slice(0, MAX_CHECK_ERROR) : '' };
}

function summarizeState(scenarioId, state) {
  return {
    key: `${scenarioId}/${state.id}`,
    id: state.id,
    name: state.name,
    description: state.description,
    actor: state.actor,
    ok: state.ok,
    error: state.error || '',
    violations: (state.violations || []).length,
    incomplete: (state.incomplete || []).length,
    viewport: state.viewport || null,
    lang: state.lang || '',
  };
}

/** What the report shows of each scenario: the full axe data stays in raw/runtime. */
export function summarizeScenarios(scenarios) {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    actors: scenario.actors || [],
    announcements: scenario.announcements || [],
    checks: Object.entries(scenario.checks || {}).map(summarizeCheck),
    states: (scenario.states || []).map((state) => summarizeState(scenario.id, state)),
  }));
}
