import AxeBuilder from '@axe-core/playwright';
import { BrowserContext, Page as PlaywrightPage } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Recording helpers for wcagAudit.spec.ts (runtime layer of the bbb-a11y-audit agent skill).
 *
 * Every audited state stores: axe violations and incomplete results (with the on-screen box of each
 * node), a JPEG screenshot of the viewport and the boxes of every visible element that has a
 * data-test/data-testid, so the report can draw a marker on any of them. Output goes to
 * A11Y_AUDIT_DIR (one JSON per scenario plus shots/).
 */

const LEVEL_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const CRITERIA = (
  '1.1.1 1.2.1 1.2.2 1.2.3 1.2.4 1.2.5 1.3.1 1.3.2 1.3.3 1.3.4 1.3.5 1.4.1 1.4.2 1.4.3 1.4.4 1.4.5 1.4.10 1.4.11 1.4.12 1.4.13 ' +
  '2.1.1 2.1.2 2.1.4 2.2.1 2.2.2 2.3.1 2.4.1 2.4.2 2.4.3 2.4.4 2.4.5 2.4.6 2.4.7 2.4.11 2.5.1 2.5.2 2.5.3 2.5.4 2.5.7 2.5.8 ' +
  '3.1.1 3.1.2 3.2.1 3.2.2 3.2.3 3.2.4 3.2.6 3.3.1 3.3.2 3.3.3 3.3.4 3.3.7 3.3.8 4.1.2 4.1.3'
).split(' ');

/**
 * Topic scope: A11Y_GUIDELINES="2.1" (or "2.1,2.4", a principle "2", or a criterion "2.4.7").
 * Empty means everything. Checks and scenarios that cannot inform the topic are skipped.
 */
export const GUIDELINES = (process.env.A11Y_GUIDELINES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** True when no topic is set, or one of `topics` (guidelines or criteria) overlaps the topic. */
export function wants(...topics: string[]) {
  if (!GUIDELINES.length) return true;
  return topics.some((g) => GUIDELINES.some((s) => g === s || g.startsWith(`${s}.`) || s.startsWith(`${g}.`)));
}

// With a topic, axe runs only the rules tagged with the topic's criteria (wcag143 = 1.4.3).
const WCAG_TAGS = GUIDELINES.length
  ? CRITERIA.filter((c) => wants(c)).map((c) => `wcag${c.replace(/\./g, '')}`)
  : LEVEL_TAGS;
const MAX_NODES = 20;
export const SETTLE_MS = 800;

export type Actor = 'moderator' | 'attendee' | 'guest' | 'variant';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AxeNodeSummary {
  target: string;
  html: string;
  summary?: string;
  box?: Box | null;
}

interface AxeRuleSummary {
  id: string;
  impact?: string | null;
  tags: string[];
  help: string;
  helpUrl: string;
  nodeCount: number;
  nodes: AxeNodeSummary[];
}

interface StateRecord {
  id: string;
  name: string;
  description: string;
  actor: Actor;
  ok: boolean;
  error?: string;
  shot?: string;
  viewport?: { width: number; height: number };
  url?: string;
  lang?: string;
  violations?: AxeRuleSummary[];
  incomplete?: AxeRuleSummary[];
  /** Rules that ran and passed in this state: evidence for criteria that pass. */
  passes?: Array<{ id: string; help: string; tags: string[]; nodeCount: number }>;
  elements?: Record<string, Box>;
  /** Accessibility tree (roles, names, states) computed by Chromium, as a YAML file under aria/. */
  aria?: string;
}

interface Announcement {
  t: number;
  actor: string;
  politeness: string;
  role?: string;
  text: string;
  region: string;
  regionCreatedWithMessage: boolean;
  none?: boolean;
  /** The recorder could not read this page: this is NOT silence. */
  unavailable?: boolean;
}

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeRule = AxeResults['violations'][number];

/**
 * Records what would reach a screen reader through live regions (aria-live, role=status/alert/log),
 * and flags messages whose region was inserted in the same moment as the message (many screen
 * readers do not announce those). Install with context.addInitScript before the pages navigate.
 */
export function announcementRecorderScript() {
  const w = window as unknown as { a11yAuditLog?: unknown[]; a11yAuditRegionSeen?: WeakMap<Element, number> };
  // Mark the document, not the window: a tab opened by the app keeps its window object when it
  // navigates from the initial blank page, so a window flag would skip the real document.
  const doc = document as unknown as { a11yAuditObserved?: boolean };
  if (doc.a11yAuditObserved) return;
  doc.a11yAuditObserved = true;
  if (!Array.isArray(w.a11yAuditLog)) w.a11yAuditLog = [];
  if (!w.a11yAuditRegionSeen) w.a11yAuditRegionSeen = new WeakMap();
  const SELECTOR = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-test') ? `[data-test=${el.getAttribute('data-test')}]` : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`;
  const lastText = new WeakMap<Element, string>();
  const start = () => {
    const observer = new MutationObserver((mutations) => {
      const now = Date.now();
      const touched = new Set<Element>();
      mutations.forEach((m) => {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const el = n as Element;
          [el, ...Array.from(el.querySelectorAll(SELECTOR))].forEach((r) => {
            if (!r.matches(SELECTOR)) return;
            if (!w.a11yAuditRegionSeen!.has(r)) w.a11yAuditRegionSeen!.set(r, now);
            // A region inserted together with its text (React re-mounting it) also carries a message.
            touched.add(r);
          });
        });
        const target = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
        const region = target?.closest(SELECTOR);
        if (region) touched.add(region);
      });
      touched.forEach((region) => {
        const full = (region.textContent || '').replace(/\s+/g, ' ').trim();
        const previous = lastText.get(region) || '';
        if (!full) {
          // The region was emptied: forget the old text, so the same message later is recorded again.
          lastText.set(region, '');
          return;
        }
        if (previous === full) return;
        lastText.set(region, full);
        // Live regions such as the chat log grow over time: keep only what was added.
        // Something was removed (a toast closed): nothing new to announce.
        if (previous && previous.includes(full)) return;
        // Regions such as the chat log or the toast stack grow: keep only what was added.
        let text = full;
        if (previous && full.startsWith(previous)) text = full.slice(previous.length).trim();
        else if (previous && full.endsWith(previous)) text = full.slice(0, full.length - previous.length).trim();
        if (!text) return;
        const role = region.getAttribute('role') || undefined;
        const politeness = region.getAttribute('aria-live') || (role === 'alert' ? 'assertive' : 'polite');
        const seen = w.a11yAuditRegionSeen!.get(region);
        w.a11yAuditLog!.push({
          t: now,
          politeness,
          role,
          text: text.slice(0, 240),
          region: describe(region),
          regionCreatedWithMessage: seen !== undefined && now - seen < 100,
        });
      });
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
}

/** Installs the recorder into a page that is already loaded (e.g. a tab opened by the app). */
export async function ensureAnnouncementRecorder(page: PlaywrightPage) {
  const installed = await page
    .evaluate(() => Boolean((document as unknown as { a11yAuditObserved?: boolean }).a11yAuditObserved))
    .catch(() => false);
  if (!installed) await page.evaluate(announcementRecorderScript);
  return installed;
}

export async function installAnnouncementRecorder(context: BrowserContext) {
  await context.addInitScript(announcementRecorderScript);
}

async function boxesFor(page: PlaywrightPage, targets: string[]): Promise<(Box | null)[]> {
  return page.evaluate((sels) => {
    return sels.map((sel) => {
      try {
        const last = sel.split(',').pop() || sel;
        const el = document.querySelector(last);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      } catch {
        return null;
      }
    });
  }, targets);
}

async function summarize(page: PlaywrightPage, rules: AxeRule[]): Promise<AxeRuleSummary[]> {
  const out: AxeRuleSummary[] = [];
  for (const rule of rules) {
    const nodes = rule.nodes.slice(0, MAX_NODES);
    const targets = nodes.map((n) => String(n.target));
    const boxes = await boxesFor(page, targets);
    out.push({
      id: rule.id,
      impact: rule.impact,
      tags: rule.tags.filter((tag) => tag.startsWith('wcag') || tag === 'best-practice'),
      help: rule.help,
      helpUrl: rule.helpUrl,
      nodeCount: rule.nodes.length,
      nodes: nodes.map((node, i) => ({
        target: targets[i],
        html: node.html.slice(0, 300),
        summary: node.failureSummary?.slice(0, 400),
        box: boxes[i],
      })),
    });
  }
  return out;
}

async function elementBoxes(page: PlaywrightPage): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const map: Record<string, { x: number; y: number; w: number; h: number }> = {};
    const els = Array.from(document.querySelectorAll('[data-test],[data-testid]')).slice(0, 1500);
    els.forEach((el) => {
      const key = el.getAttribute('data-test') || el.getAttribute('data-testid');
      if (!key || map[key]) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0) return;
      if (r.top > window.innerHeight || r.left > window.innerWidth) return;
      map[key] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return map;
  });
}

export class AuditRecorder {
  private states: StateRecord[] = [];

  private checks: Record<string, unknown> = {};

  private announcements: Announcement[] = [];

  private readonly shotsDir: string;

  constructor(
    private readonly scenario: { id: string; name: string; description: string; actors: Actor[] },
    private readonly outDir: string,
  ) {
    this.shotsDir = join(outDir, 'shots');
    mkdirSync(this.shotsDir, { recursive: true });
    mkdirSync(join(outDir, 'aria'), { recursive: true });
  }

  /** Opens a state with `enter`, audits it, screenshots it, then runs `leave` (errors in leave are tolerated). */
  async state(
    page: PlaywrightPage,
    id: string,
    name: string,
    description: string,
    options: { actor?: Actor; enter?: () => Promise<unknown>; leave?: () => Promise<unknown> } = {},
  ): Promise<boolean> {
    const { actor = this.scenario.actors[0], enter, leave } = options;
    const record: StateRecord = { id, name, description, actor, ok: false };
    try {
      if (enter) await enter();
      await page.waitForTimeout(SETTLE_MS);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      record.violations = await summarize(page, results.violations);
      record.incomplete = await summarize(page, results.incomplete);
      record.passes = results.passes.map((rule) => ({
        id: rule.id,
        help: rule.help,
        tags: rule.tags.filter((tag) => tag.startsWith('wcag')),
        nodeCount: rule.nodes.length,
      }));
      record.ok = true;
    } catch (err) {
      record.error = String(err).split('\n').slice(0, 3).join(' ').slice(0, 500);
    }
    try {
      const file = `${this.scenario.id}--${id}.jpg`;
      await page.screenshot({ path: join(this.shotsDir, file), type: 'jpeg', quality: 60 });
      record.shot = `shots/${file}`;
      record.viewport = page.viewportSize() || undefined;
      record.url = page.url().replace(/sessionToken=[^&]+/, 'sessionToken=…');
      record.lang = await page.evaluate(() => document.documentElement.lang);
      record.elements = await elementBoxes(page);
      if (wants('4.1', '1.1', '1.3', '2.4', '2.5', '3.3')) {
        const yml = await page.locator('body').ariaSnapshot({ timeout: 15000 });
        const ariaFile = `aria/${this.scenario.id}--${id}.yml`;
        writeFileSync(join(this.outDir, ariaFile), yml);
        record.aria = ariaFile;
      }
    } catch {
      // screenshot is best effort
    }
    this.states.push(record);
    try {
      if (leave) await leave();
    } catch {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    return record.ok;
  }

  /** Runs a check; with a topic set, checks whose `topics` do not overlap it are recorded as skipped. */
  async check(id: string, fn: () => Promise<unknown>, topics: string[] = []) {
    if (topics.length && !wants(...topics)) {
      this.checks[id] = { skipped: `fora do tópico (${GUIDELINES.join(', ')})` };
      return;
    }
    try {
      this.checks[id] = await fn();
    } catch (err) {
      this.checks[id] = { error: String(err).split('\n')[0].slice(0, 500) };
    }
  }

  /** Pulls the live-region log recorded on `page` since the last call. */
  async collectAnnouncements(page: PlaywrightPage, actor: string) {
    const base = { t: Date.now(), actor, politeness: 'none', text: '', region: '', regionCreatedWithMessage: false };
    const read = await page
      .evaluate(() => {
        const w = window as unknown as { a11yAuditLog?: unknown[] };
        if (!Array.isArray(w.a11yAuditLog)) return { installed: false, items: [] as unknown[] };
        const items = w.a11yAuditLog;
        w.a11yAuditLog = [];
        return { installed: true, items };
      })
      .catch((err) => ({ installed: false, items: [] as unknown[], error: String(err).slice(0, 200) }));
    if (!read.installed) {
      // Never report this as silence: the recorder was missing or the page could not be read.
      this.announcements.push({
        ...base,
        unavailable: true,
        text: 'error' in read ? read.error : 'recorder not installed',
      });
      return;
    }
    if (!read.items.length) {
      // Make silent moments explicit: an expected announcement that never came is a finding candidate.
      this.announcements.push({ ...base, none: true });
      return;
    }
    (read.items as Omit<Announcement, 'actor'>[]).forEach((item) => this.announcements.push({ ...item, actor }));
  }

  note(id: string, value: unknown) {
    this.checks[id] = value;
  }

  write() {
    const data = {
      ...this.scenario,
      generatedAt: new Date().toISOString(),
      axeTags: WCAG_TAGS,
      topic: GUIDELINES,
      states: this.states,
      checks: this.checks,
      announcements: this.announcements,
    };
    writeFileSync(join(this.outDir, `${this.scenario.id}.json`), JSON.stringify(data, null, 2));
    return data;
  }
}

/** Drops what was recorded on `page` so far (setup noise before an interaction). */
export async function clearAnnouncements(page: PlaywrightPage) {
  await page
    .evaluate(() => {
      (window as unknown as { a11yAuditLog?: unknown[] }).a11yAuditLog = [];
    })
    .catch(() => undefined);
}

export function auditOutDir(fallback: string) {
  const dir = process.env.A11Y_AUDIT_DIR || fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 1.4.10 Reflow: at 320 CSS px wide nothing should need horizontal scrolling. */
export async function checkReflow(page: PlaywrightPage) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(SETTLE_MS * 2);
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.right > window.innerWidth + 1 && getComputedStyle(el).visibility !== 'hidden';
      })
      .filter((el, _, all) => !all.some((other) => other !== el && other.contains(el)))
      .slice(0, 15)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || undefined,
        className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
        right: Math.round(el.getBoundingClientRect().right),
      }));
    return { viewportWidth: window.innerWidth, scrollWidth: doc.scrollWidth, offenders };
  });
  if (original) await page.setViewportSize(original);
  await page.waitForTimeout(SETTLE_MS);
  return { ...result, horizontalScroll: result.scrollWidth > result.viewportWidth + 1 };
}

/** 1.4.12 Text Spacing: apply the WCAG spacing and list text that becomes clipped. */
export async function checkTextSpacing(page: PlaywrightPage) {
  const findClipped = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((el) => {
          const style = getComputedStyle(el);
          const clips = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY);
          const hasText = Array.from(el.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim().length > 0,
          );
          return (
            clips &&
            hasText &&
            el.offsetParent !== null &&
            (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
          );
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            dataTest: el.closest('[data-test]')?.getAttribute('data-test') || undefined,
            className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
            text: (el.textContent || '').trim().slice(0, 80),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          };
        }),
    );

  const before = await findClipped();
  const style = await page.addStyleTag({
    content: `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p { margin-bottom: 2em !important; }`,
  });
  await page.waitForTimeout(SETTLE_MS);
  const after = await findClipped();
  await style.evaluate((node) => (node as HTMLElement).remove());
  await page.waitForTimeout(SETTLE_MS);

  const key = (item: { tag: string; className?: string; text: string }) => `${item.tag}|${item.className}|${item.text}`;
  const beforeKeys = new Set(before.map(key));
  return { newlyClipped: after.filter((item) => !beforeKeys.has(key(item))).slice(0, 25) };
}

const STATE_ATTRS = [
  'aria-pressed',
  'aria-expanded',
  'aria-checked',
  'aria-selected',
  'aria-current',
  'aria-disabled',
  'aria-label',
  'aria-haspopup',
  'role',
  'title',
];

/** Attributes of the element at `selector`, or of whatever now sits where it was (buttons often swap). */
async function stateAt(page: PlaywrightPage, selector: string, fallback?: Box | null) {
  return page.evaluate(
    ({ sel, attrs, box }) => {
      let el = document.querySelector(sel) as HTMLElement | null;
      if (!el && box) {
        const hit = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2);
        el = (hit?.closest('button,[role],a,input') as HTMLElement | null) || null;
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const out: Record<string, string | null> = {
        tag: el.tagName.toLowerCase(),
        dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid'),
        text: (el.textContent || '').trim().slice(0, 60),
        box: JSON.stringify({
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }),
      };
      attrs.forEach((a) => {
        out[a] = el!.getAttribute(a);
      });
      return out;
    },
    { sel: selector, attrs: STATE_ATTRS, box: fallback || null },
  );
}

/**
 * 4.1.2 states: activate a toggle or a menu trigger and report which ARIA attributes changed.
 * A toggle that changes visually but not in ARIA fails 4.1.2.
 */
export async function checkStateChange(page: PlaywrightPage, trigger: string, restore: 'click' | 'escape') {
  try {
    const before = await stateAt(page, trigger);
    if (!before) throw new Error('trigger not found');
    const box = before.box ? (JSON.parse(before.box) as Box) : null;
    await page.locator(trigger).first().click();
    await page.waitForTimeout(SETTLE_MS);
    const after = await stateAt(page, trigger, box);
    const changed = STATE_ATTRS.filter((a) => (before?.[a] ?? null) !== (after?.[a] ?? null));
    if (restore === 'escape') await page.keyboard.press('Escape');
    else if (after?.dataTest) await page.locator(`[data-test="${after.dataTest}"]`).first().click();
    else await page.locator(trigger).first().click();
    await page.waitForTimeout(SETTLE_MS);
    return { trigger, before, after, changedAttributes: changed, swappedElement: before.dataTest !== after?.dataTest };
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { trigger, error: String(err).split('\n')[0].slice(0, 200) };
  }
}

/**
 * 4.1.2 selection: open a menu, pick a different item, reopen it and report how the current choice
 * is exposed (aria-checked / aria-selected / aria-current / role) before and after.
 */
export async function checkMenuSelection(page: PlaywrightPage, trigger: string, itemSelector: string) {
  const readItems = () =>
    page.evaluate(
      ({ sel, attrs }) =>
        Array.from(document.querySelectorAll(sel)).map((el) => {
          const o: Record<string, string | null> = {
            id: el.id || null,
            text: (el.textContent || '').trim().slice(0, 60),
          };
          attrs.forEach((a) => {
            o[a] = el.getAttribute(a);
          });
          // Text a screen reader also gets: aria-describedby targets and visually hidden spans.
          o.describedBy = (el.getAttribute('aria-describedby') || '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent?.trim() || `(missing id ${id})`)
            .join(' | ');
          return o;
        }),
      { sel: itemSelector, attrs: ['role', 'aria-checked', 'aria-selected', 'aria-current', 'aria-label'] },
    );
  try {
    await page.locator(trigger).first().click();
    await page.waitForTimeout(SETTLE_MS);
    const before = await readItems();
    const target = page.locator(itemSelector).nth(1);
    if ((await page.locator(itemSelector).count()) < 2) throw new Error(`fewer than two items match ${itemSelector}`);
    const picked = ((await target.textContent()) || '').trim().slice(0, 60);
    await target.click();
    await page.waitForTimeout(SETTLE_MS * 2);
    await page.keyboard.press('Escape');
    await page.locator(trigger).first().click();
    await page.waitForTimeout(SETTLE_MS);
    const after = await readItems();
    await page.keyboard.press('Escape');
    return { trigger, picked, before, after };
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { trigger, error: String(err).split('\n')[0].slice(0, 200) };
  }
}

/**
 * 2.4.3 Focus Order: open a menu or modal from its trigger with the keyboard, close it with Escape,
 * and report where focus went. Focus should come back to the trigger.
 */
export async function checkFocusReturn(page: PlaywrightPage, trigger: string) {
  const describeActive = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return 'body';
      const dt = a.getAttribute('data-test') || a.getAttribute('data-testid');
      return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${dt ? `[data-test=${dt}]` : ''}`;
    });
  try {
    const loc = page.locator(trigger).first();
    await loc.focus();
    const focusable = await loc.evaluate((el) => el === document.activeElement);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(SETTLE_MS);
    const afterOpen = await describeActive();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(SETTLE_MS);
    const returned = await loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
    return {
      trigger,
      triggerFocusable: focusable,
      focusAfterOpen: afterOpen,
      returnedToTrigger: returned,
      focusAfterClose: await describeActive(),
    };
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return { trigger, error: String(err).split('\n')[0].slice(0, 200) };
  }
}

/**
 * 1.4.13 Content on Hover or Focus: for each trigger, check that its tooltip appears on hover and on
 * keyboard focus, that Escape dismisses it without moving the pointer, and that it stays while the
 * pointer moves onto it. Tooltips already on screen before the hover (persistent hints) are ignored.
 */
export async function checkHoverFocus(page: PlaywrightPage, triggers: string[]) {
  const SELECTORS = ['[role="tooltip"]', '[data-tippy-root]', '.MuiTooltip-popper'];
  const fresh = page.locator(SELECTORS.map((s) => `${s}:not([data-a11y-pre]):visible`).join(', '));
  const markExisting = () =>
    page.evaluate((sels) => {
      document.querySelectorAll('[data-a11y-pre]').forEach((el) => el.removeAttribute('data-a11y-pre'));
      document.querySelectorAll(sels.join(',')).forEach((el) => el.setAttribute('data-a11y-pre', '1'));
    }, SELECTORS);
  const waitGone = async (ms: number) => {
    const end = Date.now() + ms;
    while ((await fresh.count()) > 0 && Date.now() < end) await page.waitForTimeout(100);
    return (await fresh.count()) === 0;
  };
  const reset = async () => {
    await page.mouse.move(1, 1);
    await page.keyboard.press('Escape');
    await waitGone(1500);
    await page.waitForTimeout(300);
    await markExisting();
  };
  const results: Array<Record<string, unknown>> = [];
  for (const trigger of triggers) {
    const r: Record<string, unknown> = { trigger };
    try {
      const loc = page.locator(trigger).first();
      if (!(await loc.isVisible())) throw new Error('trigger not visible');
      await reset();
      await loc.hover();
      await page.waitForTimeout(700);
      r.appearsOnHover = (await fresh.count()) > 0;
      if (r.appearsOnHover) {
        r.text = ((await fresh.first().textContent()) || '').trim().slice(0, 80);
        await page.keyboard.press('Escape');
        r.dismissibleWithEscape = await waitGone(1000);
        await reset();
        await loc.hover();
        await page.waitForTimeout(700);
        const box = await fresh.first().boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
          await page.waitForTimeout(500);
          r.hoverable = (await fresh.count()) > 0;
        }
      }
      await reset();
      await loc.focus();
      await page.waitForTimeout(700);
      r.appearsOnFocus = (await fresh.count()) > 0;
    } catch (err) {
      r.error = String(err).split('\n')[0].slice(0, 200);
    }
    results.push(r);
  }
  await page.mouse.move(1, 1);
  await page.keyboard.press('Escape');
  return results;
}

/** 2.1.1 / 2.1.2 / 2.4.3 / 2.4.7 / 2.4.11: walk the page with Tab and describe every focus stop. */
export async function checkKeyboard(page: PlaywrightPage, maxStops = 80) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: Array<Record<string, unknown>> = [];
  let trap = false;

  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { tag: 'body' };
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const visible = rect.width > 0 && rect.height > 0;
      const labelledBy = el.getAttribute('aria-labelledby');
      const name = (
        el.getAttribute('aria-label') ||
        (labelledBy && document.getElementById(labelledBy)?.textContent) ||
        el.textContent ||
        el.getAttribute('title') ||
        (el as HTMLInputElement).placeholder ||
        ''
      ).trim();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        name: name.slice(0, 60),
        dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || undefined,
        id: el.id || undefined,
        visible,
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        // Candidate only: focus may still show through background, border or a child.
        noOutlineOrShadow:
          (style.outlineStyle === 'none' || style.outlineWidth === '0px') && style.boxShadow === 'none',
        obscured: visible && !!top && top !== el && !el.contains(top) && !top.contains(el),
        signature: `${el.tagName}|${el.id}|${el.getAttribute('data-test')}|${Math.round(rect.left)},${Math.round(rect.top)}`,
      };
    });
    const previous = stops.slice(-2);
    if (previous.length === 2 && previous.every((p) => p.signature && p.signature === stop.signature)) {
      trap = true;
      stops.push(stop);
      break;
    }
    if (stops.length > 3 && stop.signature && stop.signature === stops[0].signature) break;
    stops.push(stop);
  }
  return { stopCount: stops.length, possibleTrap: trap, stops };
}
