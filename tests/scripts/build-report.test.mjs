import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BROKEN_JSON_RUN, createFixtureRepo, INVALID_RUN, RUN } from '../helpers/fixture-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../../bbb-a11y-audit/scripts/build-report.mjs', import.meta.url));

describe('build-report', () => {
  let repo;
  const build = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });

  before(() => {
    repo = createFixtureRepo();
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  describe('a valid run', () => {
    let run;
    let output;
    let byTitle;
    before(() => {
      run = build(RUN);
      output = JSON.parse(readFileSync(join(repo, RUN, 'findings.json'), 'utf8'));
      byTitle = Object.fromEntries(output.findings.map((f) => [f.title, f]));
    });

    it('succeeds and prints a summary', () => {
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /findings: 6 \(this phase 3, backlog 3\)/);
      assert.match(run.stdout, /coverage: skip 53, fail 2/);
      assert.match(run.stdout, /vs 2026-01-01_1000_d4\.1: 4 new, 1 regressed, 1 fixed, 1 not re-checked/);
    });

    it('warns about screenshot markers that found nothing, without failing', () => {
      assert.match(run.stderr, /data-test "not-on-screen" not visible in moderator\/meeting/);
      assert.match(run.stderr, /no on-screen node for rule "color-contrast"/);
    });

    it('keeps explicit ids and derives stable ones from criterion, file and key', () => {
      assert.equal(byTitle['Menu é uma div clicável'].id, 'A11Y-keep01');
      assert.match(byTitle['Preferências do usuário'].id, /^A11Y-[0-9a-f]{6}$/);
      const again = build(RUN);
      assert.equal(again.status, 0);
      const ids = JSON.parse(readFileSync(join(repo, RUN, 'findings.json'), 'utf8')).findings.map((f) => f.id);
      assert.deepEqual(
        ids,
        output.findings.map((f) => f.id),
      );
    });

    it('puts in the backlog only external work, large effort or an explicit decision', () => {
      const phase = (title) => [byTitle[title].bucket, byTitle[title].backlogReason];
      assert.deepEqual(phase('Menu é uma div clicável'), ['now', '']);
      assert.deepEqual(phase('Depende da biblioteca do player'), ['backlog', 'Depende de uma biblioteca externa.']);
      assert.deepEqual(phase('Região do toast criada com a mensagem'), [
        'backlog',
        'Esforço grande: precisa de planejamento próprio.',
      ]);
      assert.deepEqual(phase('Backlog decidido pelo agente'), ['backlog', 'Motivo próprio']);
    });

    it('orders findings: this phase first, then by impact, then by effort', () => {
      assert.deepEqual(
        output.findings.map((f) => [f.bucket, f.impact]),
        [
          ['now', 'medium'],
          ['now', 'medium'],
          ['now', 'medium'],
          ['backlog', 'blocker'],
          ['backlog', 'high'],
          ['backlog', 'low'],
        ],
      );
    });

    it('adds the EN 301 549 clause', () => {
      assert.equal(byTitle['Menu é uma div clicável'].en, '9.4.1.2');
      assert.equal(byTitle['Preferências do usuário'].en, '9.7');
    });

    it('resolves screenshot markers from axe nodes and data-test boxes, without duplicates', () => {
      const [byRule, byDataTest, narrowed] = byTitle['Menu é uma div clicável'].evidenceShots;
      assert.deepEqual(byRule, {
        shot: 'moderator/meeting',
        caption: 'Botões sem nome',
        boxes: [{ x: 1, y: 2, w: 3, h: 4 }],
        viewport: { width: 1366, height: 768 },
      });
      assert.deepEqual(byDataTest.boxes, [{ x: 10, y: 20, w: 30, h: 40 }]);
      assert.deepEqual(narrowed.boxes, [
        { x: 5, y: 5, w: 5, h: 5 },
        { x: 1, y: 2, w: 3, h: 4 },
      ]);
    });

    it('compares with the latest run of the same topic only', () => {
      const status = (title) => byTitle[title].status;
      assert.equal(status('Menu é uma div clicável'), 'persisting');
      assert.equal(status('Voltou depois de corrigido'), 'regressed');
      assert.equal(status('Preferências do usuário'), 'new');
      assert.equal(output.meta.previousRunDir, '2026-01-01_1000_d4.1');
      assert.equal(output.meta.previousRunScope, 'g:4.1');
    });

    it('calls a gone finding fixed only when the layer that found it ran again', () => {
      assert.deepEqual(
        output.fixed.map((f) => f.id),
        ['A11Y-gone01'],
      );
      assert.deepEqual(
        output.notRechecked.map((f) => f.id),
        ['A11Y-gone02'],
      );
    });

    it('derives failing criteria from findings and skips the rest of the standard', () => {
      assert.equal(output.coverage['4.1.2'].status, 'fail');
      assert.equal(output.coverage['4.1.2'].how, 'axe em todas as telas');
      assert.equal(output.coverage['1.4.3'].status, 'skip');
      assert.equal(output.coverage['4.1.2'].checklist.length, 8);
      assert.equal(output.coverage['4.1.2'].checklist[0].result, 'fail');
      assert.ok(output.coverage['4.1.2'].checklist[0].label, 'checklist labels come from checklists.json');
    });

    it('summarizes the runtime data for the report', () => {
      assert.deepEqual(
        output.scenarios.map((s) => s.id),
        ['moderator', 'guest', 'zzz'],
      );
      assert.deepEqual(output.meta.server, {
        url: 'https://bbb.test',
        bbbServerVersion: null,
        html5ClientBuild: '4.1.0',
      });
      assert.deepEqual(
        output.scenarios[0].checks.find((c) => c.id === 'reflowError'),
        { id: 'reflowError', ok: false, error: 'boom' },
      );
      assert.deepEqual(output.axeEvidence['4.1.2'].rules['button-name'], {
        help: 'Buttons must have discernible text',
        passed: 0,
        failed: 1,
      });
      assert.equal(output.axeEvidence['4.1.2'].screens, 3);
    });

    it('writes a self-contained report with the data and the screenshots inlined', () => {
      const html = readFileSync(join(repo, RUN, 'report.html'), 'utf8');
      assert.ok(!html.includes('__DATA__'));
      assert.ok(html.includes('data:image/jpeg;base64,'));
      assert.ok(html.includes('\\u003cdiv onClick={open}'), '"<" is escaped inside the JSON');
    });
  });

  describe('an invalid run', () => {
    let run;
    before(() => {
      run = build(INVALID_RUN);
    });

    it('fails without writing anything', () => {
      assert.equal(run.status, 1);
      assert.ok(!existsSync(join(repo, INVALID_RUN, 'findings.json')));
      assert.ok(!existsSync(join(repo, INVALID_RUN, 'report.html')));
    });

    it('lists every problem in one pass', () => {
      const expected = [
        'findings[0] "Sem nada": missing criterion',
        'findings[1] "Duplicado": impact must be one of blocker, high, medium, low',
        'findings[2] "Duplicado": "backlog": true needs "backlogReason"',
        'findings[3] "Linha inexistente": criterion 9.9.9 is not a WCAG 2.2 A/AA criterion',
        'shots[].state "nope/x" does not exist',
        /duplicate id A11Y-[0-9a-f]{6} \("Duplicado" and "Duplicado"\)/,
        'coverage 1.1.1: "not-covered" needs "how"',
        'coverage 1.2.1: "pass" needs "method"',
        'coverage 2.4.7: check "Roteiro inexistente" is not a manualChecks flow',
        'file "src/nope.jsx" does not exist',
        'src/menu.jsx has 10 lines, line 99 does not exist',
        'finding "Citação inventada": "quote" is not found in src/menu.jsx around line 5',
        'coverage 4.1.2: checklist item 4.1.2-a not answered',
        'coverage 4.1.2: "explored" is required',
      ];
      for (const message of expected) {
        if (message instanceof RegExp) assert.match(run.stderr, message);
        else assert.ok(run.stderr.includes(message), `missing: ${message}`);
      }
    });
  });

  it('fails clearly on a broken JSON input, a missing input and a missing argument', () => {
    assert.match(build(BROKEN_JSON_RUN).stderr, /invalid JSON in .*findings\.input\.json/);
    assert.match(build('a11y-reports/nope').stderr, /missing .*findings\.input\.json/);
    const usage = build();
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: node build-report\.mjs <run-dir>/);
  });
});
