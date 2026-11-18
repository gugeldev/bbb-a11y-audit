/**
 * Builds a throwaway git repository with audit runs next to each other, the way the skill lays them
 * out (a11y-reports/<YYYY-MM-DD_HHMM>_<topic>/), for build-report tests.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const RUN = 'a11y-reports/2026-01-02_1000_d4.1';
export const INVALID_RUN = 'a11y-reports/2026-01-03_1000_invalid';
export const BROKEN_JSON_RUN = 'a11y-reports/2026-01-04_1000_broken';

const SOURCE_FILES = {
  'src/menu.jsx': [
    'import React from "react";',
    '',
    'export function Menu() {',
    '  return (',
    '    <div onClick={open} className="trigger">',
    '      <span>Menu</span>',
    '    </div>',
    '  );',
    '}',
    '',
  ],
  'src/toast.jsx': [
    'export const Toast = ({ msg }) => (',
    '  <div>',
    '    {msg && <div role="status">{msg}</div>}',
    '  </div>',
    ');',
    '',
  ],
  'src/styles.css': ['.btn:focus {', '  outline: none;', '}', ''],
};

const BUTTON_NAME = {
  id: 'button-name',
  help: 'Buttons must have discernible text',
  tags: ['wcag2a', 'wcag412', 'section508'],
  nodes: [
    { target: '.a', box: { x: 1, y: 2, w: 3, h: 4 } },
    { target: '.b', box: { x: 1, y: 2, w: 3, h: 4 } },
    { target: '.c', box: null },
  ],
};

const PASSES = [
  { id: 'aria-roles', help: 'roles', tags: ['wcag2a', 'wcag412'], nodeCount: 3 },
  { id: 'color-contrast', help: 'contrast', tags: ['wcag2aa', 'wcag143'], nodeCount: 9 },
];

function state(id, violations = []) {
  return {
    id,
    name: `Tela ${id}`,
    description: `Descrição da tela ${id}`,
    actor: 'moderator',
    ok: true,
    shot: `shots/${id}.jpg`,
    viewport: { width: 1366, height: 768 },
    lang: 'en',
    violations,
    incomplete: [],
    passes: PASSES,
    elements: { trigger: { x: 10, y: 20, w: 30, h: 40 } },
  };
}

function scenario(id, states, checks = {}) {
  return {
    id,
    name: `Cenário ${id}`,
    description: `Descrição do cenário ${id}`,
    actors: ['moderator'],
    states,
    checks,
    announcements: [{ t: 1, actor: 'moderador', politeness: 'polite', text: 'Oi', region: 'div[role=status]' }],
  };
}

function finding(overrides) {
  return {
    impact: 'medium',
    effort: 'S',
    affects: 'Quem',
    fix: 'Como',
    verify: 'Verificar',
    evidence: 'Prova',
    ...overrides,
  };
}

function checklist(criterion, letters, result) {
  return letters.map((letter) => ({ id: `${criterion}-${letter}`, result, evidence: 'ver static:menu' }));
}

const VALID_INPUT = {
  meta: {
    summary: 'Resumo da rodada',
    guidelines: ['4.1'],
    mode: 'guideline',
    scope: 'src',
    scopePaths: ['src'],
    reviewedFlows: [{ name: 'Menu', description: 'menu/' }],
    notCovered: [{ name: 'Gravações', reason: 'fora do cliente' }],
    layers: [
      { id: 'static', name: 'Estática', ran: true },
      { id: 'runtime', name: 'Runtime', ran: false, reason: 'sem BBB_URL' },
      { id: 'review', name: 'Revisão', ran: true },
    ],
  },
  findings: [
    finding({
      title: 'Menu é uma div clicável',
      criterion: '4.1.2',
      source: 'static',
      key: 'static:menu',
      id: 'A11Y-keep01',
      location: { file: 'src/menu.jsx', line: 5 },
      quote: '<div onClick={open}',
      shots: [
        { state: 'moderator/meeting', rule: 'button-name', caption: 'Botões sem nome' },
        { state: 'moderator/meeting', dataTest: ['trigger', 'not-on-screen'] },
        { state: 'moderator/meeting', rule: 'button-name', target: '.b', boxes: [{ x: 5, y: 5, w: 5, h: 5 }] },
      ],
    }),
    finding({
      title: 'Região do toast criada com a mensagem',
      criterion: '4.1.3',
      source: 'review',
      key: 'review:toast',
      impact: 'high',
      effort: 'L',
      location: { file: 'src/toast.jsx', line: 3 },
      quote: '{msg && <div role="status">',
      relatedLocations: [{ file: 'src/menu.jsx', line: 2 }],
    }),
    finding({
      title: 'Depende da biblioteca do player',
      criterion: '4.1.2',
      source: 'runtime',
      impact: 'blocker',
      effort: 'M',
      external: true,
      location: { file: 'src/menu.jsx' },
      shots: [{ state: 'moderator/meeting', rule: 'color-contrast' }],
    }),
    finding({
      title: 'Backlog decidido pelo agente',
      criterion: '4.1.2',
      source: 'runtime',
      impact: 'low',
      backlog: true,
      backlogReason: 'Motivo próprio',
      location: { file: 'src/menu.jsx', selector: '.x' },
      confidence: 'likely',
    }),
    finding({
      title: 'Voltou depois de corrigido',
      criterion: '4.1.3',
      source: 'static',
      id: 'A11Y-regr01',
      location: { file: 'src/toast.jsx', line: 1 },
      quote: 'export const Toast',
    }),
    finding({
      title: 'Preferências do usuário',
      criterion: '9.7',
      standard: 'EN',
      criterionName: 'Preferências do usuário',
      source: 'static',
      key: 'static:en',
      location: { file: 'src/styles.css', line: 2 },
      quote: 'outline: none;',
    }),
  ],
  coverage: {
    '4.1.2': {
      method: 'tool',
      how: 'axe em todas as telas',
      checklist: [...checklist('4.1.2', ['a'], 'fail'), ...checklist('4.1.2', [...'bcdefgh'], 'pass')],
      explored: 'Componentes de terceiros',
    },
    '4.1.3': {
      method: 'agent',
      how: 'li o código',
      checklist: checklist('4.1.3', [...'abcdef'], 'na'),
      explored: 'Toasts',
    },
    '1.4.3': { status: 'pass', method: 'tool', how: 'fora do tópico: ignorado' },
  },
  discarded: [{ source: 'static:outline-none', file: 'src/styles.css', line: 2, reason: 'tem :focus-visible' }],
  manualChecks: [{ flow: 'Toasts', tool: 'NVDA', steps: ['Abrir'], expect: 'Lido', optional: true }],
};

const INVALID_INPUT = {
  meta: { criteria: ['4.1.2', '1.2.1', '2.4.7', '1.1.1'] },
  findings: [
    { title: 'Sem nada' },
    {
      title: 'Duplicado',
      criterion: '4.1.2',
      impact: 'enorme',
      effort: 'S',
      source: 'static',
      location: { file: 'src/nope.jsx', line: 3 },
      key: 'k',
    },
    {
      title: 'Duplicado',
      criterion: '4.1.2',
      impact: 'low',
      effort: 'S',
      source: 'static',
      location: { file: 'src/nope.jsx', line: 3 },
      key: 'k',
      backlog: true,
    },
    {
      title: 'Linha inexistente',
      criterion: '9.9.9',
      impact: 'low',
      effort: 'S',
      source: 'static',
      location: { file: 'src/menu.jsx', line: 99 },
      shots: [{ state: 'nope/x' }],
    },
    {
      title: 'Citação inventada',
      criterion: '4.1.2',
      impact: 'low',
      effort: 'S',
      source: 'review',
      location: { file: 'src/menu.jsx', line: 5 },
      quote: 'not in the file',
      key: 'q',
    },
  ],
  coverage: {
    '1.2.1': { status: 'pass' },
    '2.4.7': { status: 'human', check: 'Roteiro inexistente' },
    '1.1.1': 'manual',
  },
  manualChecks: [],
};

const PREVIOUS_RUNS = {
  'a11y-reports/2025-12-01_1000_d4.1/findings.json': {
    meta: { guidelines: ['4.1'] },
    findings: [
      { id: 'A11Y-regr01', title: 'old', criterion: '4.1.3', source: 'static', location: { file: 'src/toast.jsx' } },
    ],
  },
  'a11y-reports/2026-01-01_1000_d4.1/findings.json': {
    meta: { guidelines: ['4.1'], date: '2026-01-01T10:00:00.000Z' },
    findings: [
      {
        id: 'A11Y-keep01',
        title: 'still there',
        criterion: '4.1.2',
        source: 'static',
        location: { file: 'src/menu.jsx' },
      },
      { id: 'A11Y-gone01', title: 'fixed', criterion: '4.1.2', source: 'static', location: { file: 'src/menu.jsx' } },
      {
        id: 'A11Y-gone02',
        title: 'not re-checked',
        criterion: '4.1.3',
        source: 'runtime',
        location: { file: 'src/toast.jsx' },
      },
      {
        id: 'A11Y-other1',
        title: 'other topic',
        criterion: '2.4.7',
        source: 'static',
        location: { file: 'src/styles.css' },
      },
    ],
  },
  // Another topic: never compared with a 4.1 run.
  'a11y-reports/2026-01-01_1200_d2.4/findings.json': {
    meta: { guidelines: ['2.4'] },
    findings: [
      { id: 'A11Y-keep01', title: 'x', criterion: '4.1.2', source: 'static', location: { file: 'src/menu.jsx' } },
    ],
  },
};

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Creates the repository and returns its path. */
export function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-a11y-audit-'));
  for (const [path, lines] of Object.entries(SOURCE_FILES)) write(root, path, lines.join('\n'));
  execSync('git init -q && git add -A && git -c user.email=test@example.com -c user.name=test commit -qm init', {
    cwd: root,
  });

  for (const [path, data] of Object.entries(PREVIOUS_RUNS)) write(root, path, data);

  const runtime = `${RUN}/raw/runtime`;
  const server = { url: 'https://bbb.test', bbbServerVersion: 'HTML5_SERVER_VERSION', html5ClientBuild: '4.1.0' };
  const broken = {
    id: 'broken',
    name: 'Quebrada',
    description: 'Não abriu',
    actor: 'moderator',
    ok: false,
    error: 'timeout',
  };
  write(
    root,
    `${runtime}/moderator.json`,
    scenario('moderator', [state('meeting', [BUTTON_NAME]), broken], { server, reflowError: 'boom' }),
  );
  write(root, `${runtime}/zzz.json`, scenario('zzz', [state('z1')]));
  write(root, `${runtime}/guest.json`, scenario('guest', [state('lobby')]));
  write(root, `${runtime}/shots/meeting.jpg`, 'JPEG-1');
  write(root, `${runtime}/shots/lobby.jpg`, 'JPEG-2');
  write(root, `${RUN}/raw/findings.input.json`, VALID_INPUT);

  write(root, `${INVALID_RUN}/raw/findings.input.json`, INVALID_INPUT);
  write(root, `${BROKEN_JSON_RUN}/raw/findings.input.json`, '{ not json');
  return root;
}
