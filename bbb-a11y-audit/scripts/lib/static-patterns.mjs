/**
 * Accessibility anti-patterns searched by static-scan.mjs. Every hit is a CANDIDATE that the agent
 * triages by reading the code (references/static-patterns.md explains how, pattern by pattern).
 *
 * Fields:
 *   id         stable name, used in raw/static.json and in `discarded[].source` ("static:<id>")
 *   criterion  WCAG criterion it can fail (or an EN 301 549 clause with `standard: 'EN'`)
 *   also       other criteria the same hit can fail, used only to select patterns by topic
 *   kinds      file kinds it runs on: 'code', 'style' or 'markup'
 *   re         global regex run over the whole file, so JSX that spans lines is matched
 *   hint       what the hit means, for the person or agent triaging it
 */
export const PATTERNS = [
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
    also: ['2.1.1'],
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
    also: ['1.3.1', '4.1.2'],
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
