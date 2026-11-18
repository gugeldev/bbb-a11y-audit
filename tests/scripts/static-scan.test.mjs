import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../bbb-a11y-audit/scripts/static-scan.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/static/', import.meta.url));

function scan(...args) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: FIXTURES, encoding: 'utf8' });
  return { ...run, report: run.status === 0 ? JSON.parse(run.stdout) : null };
}

const hitsOf = (report) => report.hits.map((hit) => `${hit.pattern} ${hit.file}:${hit.line}`);

describe('static-scan', () => {
  it('finds every known candidate with its file and line', () => {
    const { report } = scan('.');
    assert.deepEqual(hitsOf(report).sort(), [
      'autoplay-media page.html:2',
      'conditional-live-region components/menu.jsx:9',
      'html-font-size-px styles/base.css:3',
      'outline-none styles/base.css:2',
      'placeholder-as-label components/menu.jsx:10',
      'positive-tabindex components/menu.jsx:8',
      'single-key-shortcut components/menu.jsx:18',
      'static-element-click components/menu.jsx:5',
      'viewport-zoom-blocked page.html:1',
    ]);
  });

  it('does not flag the safe variants', () => {
    const snippets = scan('.').report.hits.map((hit) => hit.snippet);
    assert.ok(!snippets.some((s) => s.includes('aria-label="Search users"')), 'labelled input');
    assert.ok(!snippets.some((s) => s.includes('role="button"')), 'clickable div with a role');
    assert.ok(!snippets.some((s) => s.includes('muted')), 'muted autoplay');
  });

  it('skips node_modules, test folders, spec files and unknown file types', () => {
    const { report } = scan('.');
    assert.equal(report.scannedFiles, 3);
    assert.ok(report.hits.every((hit) => !/node_modules|__tests__|\.spec\.|notes\.txt/.test(hit.file)));
  });

  it('keeps only the patterns of the requested topic', () => {
    const { report } = scan('--guidelines=4.1', '.');
    assert.deepEqual(report.topic, ['4.1']);
    assert.deepEqual(report.patterns.map((p) => p.id).sort(), [
      'conditional-live-region',
      'placeholder-as-label',
      'static-element-click',
    ]);
    assert.ok(
      report.patterns.every((p) => !('re' in p) && !('kinds' in p)),
      'regexes stay internal',
    );
  });

  it('selects EN 301 549 user-preference patterns with the visual topic 1.4', () => {
    const ids = scan('--guidelines=1.4', '.').report.patterns.map((p) => p.id);
    assert.ok(ids.includes('html-font-size-px') && ids.includes('forced-colors-none'));
  });

  it('counts candidates per pattern and accepts a single file', () => {
    const { report, stderr } = scan('styles/base.css');
    assert.deepEqual(report.counts, { 'outline-none': 1, 'html-font-size-px': 1 });
    assert.match(stderr, /static-scan: 1 files, 2 candidates/);
  });

  it('fails with usage when no path is given', () => {
    const { status, stderr } = scan('--guidelines=4.1');
    assert.equal(status, 1);
    assert.match(stderr, /usage: node static-scan\.mjs/);
  });
});
