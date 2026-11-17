#!/usr/bin/env node
/**
 * Pattern scan for accessibility anti-patterns. Prints CANDIDATES as JSON: every hit must be
 * triaged by reading the code (see references/static-patterns.md) before it becomes a finding.
 *
 *   node static-scan.mjs <path> [<path> ...] > raw/static.json
 *
 * No dependencies. Skips node_modules, tests, build output and locale files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const CODE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const STYLE = new Set(['.css', '.scss', '.less']);
const MARKUP = new Set(['.html']);
const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.git|tests?|__tests__|__mocks__|locales|compatibility)(\/|$)/;
const SKIP_FILE = /(\.spec\.|\.test\.|\.min\.|\.d\.ts$)/;

/**
 * kinds: which file types the pattern runs on. Regexes run over the whole file (so JSX that spans
 * lines is matched) and the line number is computed from the match offset.
 */
const PATTERNS = [
  {
    id: 'outline-none',
    criterion: '2.4.7',
    kinds: ['code', 'style'],
    re: /outline\s*:\s*(?:none|0)\b[^;\n]*/g,
    hint: 'Removes the focus outline. Fine only if the same rule (or :focus-visible) adds another visible indicator.',
  },
  {
    id: 'positive-tabindex',
    criterion: '2.4.3',
    kinds: ['code', 'markup'],
    re: /tab[iI]ndex\s*=\s*\{?\s*["']?\s*[1-9]\d*/g,
    hint: 'tabindex > 0 overrides the natural focus order.',
  },
  {
    id: 'paste-blocked',
    criterion: '3.3.8',
    kinds: ['code'],
    re: /onPaste\s*=\s*\{[\s\S]{0,200}?preventDefault|addEventListener\(\s*['"]paste['"][\s\S]{0,200}?preventDefault/g,
    hint: 'Blocking paste breaks password managers and copying codes (Accessible Authentication).',
  },
  {
    id: 'conditional-live-region',
    criterion: '4.1.3',
    kinds: ['code'],
    re: /(?:&&|\?)\s*\(?\s*<[A-Za-z][\w.]*\b[^>]*?(?:role\s*=\s*\{?["'](?:status|alert|log)["']|aria-live\s*=)/g,
    hint: 'Live region mounted together with its message. Many screen readers only announce changes to a region that already existed.',
  },
  {
    id: 'static-element-click',
    criterion: '4.1.2',
    kinds: ['code'],
    re: /<(?:div|span|li|p|img|section|svg|td|tr)\b(?=[^>]*\bonClick\s*=)(?![^>]*\brole\s*=)[^>]*>/g,
    hint: 'Clickable non-interactive element without role. Check keyboard support (2.1.1) and name/role (4.1.2). Arrow functions can cut the match short: read the real tag.',
  },
  {
    id: 'aria-label-literal-with-text',
    criterion: '2.5.3',
    kinds: ['code', 'markup'],
    re: /<(?:button|a)\b[^>]*\baria-label\s*=\s*\{?["'`]([^"'`]+)["'`]\}?[^>]*>\s*([A-Za-zÀ-ÿ][^<{]{1,60})</g,
    hint: 'Literal aria-label next to visible text: the accessible name must contain the visible label.',
  },
  {
    id: 'placeholder-as-label',
    criterion: '3.3.2',
    kinds: ['code', 'markup'],
    re: /<(?:input|textarea)\b(?=[^>]*\bplaceholder\s*=)(?![^>]*\b(?:aria-label|aria-labelledby|id)\s*=)[^>]*>/g,
    hint: 'Field with placeholder and no aria-label, aria-labelledby or id (so no <label for>). Placeholder alone is not a label.',
  },
  {
    id: 'autoplay-media',
    criterion: '1.4.2',
    kinds: ['code', 'markup'],
    re: /<(?:video|audio)\b(?=[^>]*\bauto[pP]lay\b)(?![^>]*\bmuted\b)[^>]*>/g,
    hint: 'Media that autoplays with sound needs a way to pause or mute it.',
  },
  {
    id: 'viewport-zoom-blocked',
    criterion: '1.4.4',
    kinds: ['markup', 'code'],
    re: /name\s*=\s*["']viewport["'][^>]*?(?:user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?\b)/g,
    hint: 'Viewport meta that blocks pinch zoom (axe: meta-viewport).',
  },
  {
    id: 'single-key-shortcut',
    criterion: '2.1.4',
    kinds: ['code'],
    re: /\.(?:key|code|keyCode|which)\s*[!=]==?\s*(?:['"](?:Key|Digit)?[A-Za-z0-9?/]['"]|KEYS\.[A-Za-z0-9]\b)/g,
    hint: 'Keyboard handler reacting to a single character key. Fine if it requires a modifier, can be turned off or remapped, or only fires while the component has focus.',
  },
  {
    id: 'forced-colors-none',
    criterion: '9.7',
    standard: 'EN',
    kinds: ['code', 'style'],
    re: /forced-color-adjust\s*:\s*none/g,
    hint: 'EN 301 549 9.7: overrides the user high-contrast setting unless essential.',
  },
  {
    id: 'html-font-size-px',
    criterion: '9.7',
    standard: 'EN',
    kinds: ['code', 'style'],
    re: /(?:^|[\s,}])html\s*\{[^}]*?font-size\s*:\s*\d+(?:\.\d+)?px/g,
    hint: 'Root font-size in px ignores the browser default font size the user chose. Not explicit in the norm: report as low impact.',
  },
];

function kindOf(file) {
  const ext = extname(file);
  if (CODE.has(ext)) return 'code';
  if (STYLE.has(ext)) return 'style';
  if (MARKUP.has(ext)) return 'markup';
  return null;
}

function* walk(path) {
  const st = statSync(path);
  if (st.isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(`/${entry.name}/`)) yield* walk(full);
    } else if (!SKIP_FILE.test(entry.name)) {
      yield full;
    }
  }
}

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('usage: node static-scan.mjs <path> [<path> ...]');
  process.exit(1);
}

const cwd = process.cwd();
const hits = [];
let files = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    const kind = kindOf(file);
    if (!kind) continue;
    files++;
    const text = readFileSync(file, 'utf8');
    for (const p of PATTERNS) {
      if (!p.kinds.includes(kind)) continue;
      p.re.lastIndex = 0;
      for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({
          pattern: p.id,
          criterion: p.criterion,
          standard: p.standard || 'WCAG',
          file: relative(cwd, file),
          line,
          snippet: m[0].replace(/\s+/g, ' ').trim().slice(0, 200),
        });
        if (m[0].length === 0) p.re.lastIndex++;
      }
    }
  }
}

const byPattern = {};
for (const h of hits) byPattern[h.pattern] = (byPattern[h.pattern] || 0) + 1;
console.log(
  JSON.stringify(
    { scannedFiles: files, roots, patterns: PATTERNS.map(({ re, kinds, ...rest }) => rest), counts: byPattern, hits },
    null,
    2,
  ),
);
console.error(`static-scan: ${files} files, ${hits.length} candidates ${JSON.stringify(byPattern)}`);
