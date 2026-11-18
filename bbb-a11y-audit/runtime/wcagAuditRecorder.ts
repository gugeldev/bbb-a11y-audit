import AxeBuilder from '@axe-core/playwright';
import { Page as PlaywrightPage } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { waitForAlertQueue } from './wcagAuditAnnouncements';

/**
 * Recording side of the runtime layer of the bbb-a11y-audit agent skill (used by wcagAudit.spec.ts).
 *
 * Every audited state stores: axe violations and incomplete results (with the on-screen box of each
 * node), the rules that passed, a JPEG screenshot of the viewport, the boxes of every visible element
 * that has a data-test/data-testid (so the report can mark any of them) and the accessibility tree.
 * Output goes to A11Y_AUDIT_DIR: one JSON per scenario, plus shots/ and aria/.
 */

const LEVEL_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const CRITERIA = [
  ...['1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5'],
  ...['1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13'],
  ...['2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2', '2.3.1'],
  ...['2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.11'],
  ...['2.5.1', '2.5.2', '2.5.3', '2.5.4', '2.5.7', '2.5.8'],
  ...['3.1.1', '3.1.2', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.6'],
  ...['3.3.1', '3.3.2', '3.3.3', '3.3.4', '3.3.7', '3.3.8'],
  ...['4.1.2', '4.1.3'],
];
// The accessibility tree is only worth its size for topics that judge names, roles and structure.
const ARIA_SNAPSHOT_TOPICS = ['4.1', '1.1', '1.3', '2.4', '2.5', '3.3'];
const ARIA_SNAPSHOT_TIMEOUT = 15000;
const MAX_AXE_NODES = 20;
const MAX_MARKED_ELEMENTS = 1500;
const SCREENSHOT_QUALITY = 60;

/** Pause after every interaction, so animations and React updates settle before measuring. */
export const SETTLE_MS = 800;

/**
 * Topic scope: A11Y_GUIDELINES="2.1" (or "2.1,2.4", a principle "2", or a criterion "2.4.7").
 * Empty means everything. Checks and scenarios that cannot inform the topic are skipped.
 */
export const GUIDELINES = (process.env.A11Y_GUIDELINES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** True when no topic is set, or one of `topics` (guidelines or criteria) overlaps the topic. */
export function wants(...topics: string[]) {
  if (!GUIDELINES.length) return true;
  return topics.some((topic) => GUIDELINES.some((selected) => overlaps(topic, selected)));
}

// With a topic, axe runs only the rules tagged with the topic's criteria (wcag143 = 1.4.3).
const AXE_TAGS = GUIDELINES.length
  ? CRITERIA.filter((criterion) => wants(criterion)).map((criterion) => `wcag${criterion.replace(/\./g, '')}`)
  : LEVEL_TAGS;

export type Actor = 'moderator' | 'attendee' | 'guest' | 'variant';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScenarioInfo {
  id: string;
  name: string;
  description: string;
  actors: Actor[];
}

export interface StateOptions {
  id: string;
  name: string;
  description: string;
  /** Who is looking at this screen; defaults to the scenario's first actor. */
  actor?: Actor;
  /** Opens the state. When it throws, the state is recorded as not audited (`ok: false`). */
  enter?: () => Promise<unknown>;
  /** Restores the page for the next state. When it throws, Escape is pressed instead. */
  leave?: () => Promise<unknown>;
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

/** First `lines` lines of an error, capped at `max` characters: enough to say what broke. */
export function errorMessage(err: unknown, { lines = 1, max = 200 } = {}) {
  return String(err).split('\n').slice(0, lines).join(' ').slice(0, max);
}

/** Escape closes menus, popovers and modals; failing to press it is never worth an error. */
export async function pressEscape(page: PlaywrightPage) {
  await page.keyboard.press('Escape').catch(() => undefined);
}

export async function settle(page: PlaywrightPage, times = 1) {
  await page.waitForTimeout(SETTLE_MS * times);
}

/** Where an axe node is on screen: its last selector part, which is the node itself in iframes too. */
async function boxesOf(page: PlaywrightPage, targets: string[]): Promise<(Box | null)[]> {
  return page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        try {
          const el = document.querySelector(selector.split(',').pop() || selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        } catch {
          return null;
        }
      }),
    targets,
  );
}

async function summarizeRules(page: PlaywrightPage, rules: AxeRule[]): Promise<AxeRuleSummary[]> {
  const summaries: AxeRuleSummary[] = [];
  for (const rule of rules) {
    const nodes = rule.nodes.slice(0, MAX_AXE_NODES);
    const targets = nodes.map((node) => String(node.target));
    const boxes = await boxesOf(page, targets);
    summaries.push({
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
  return summaries;
}

/** Visible elements with a data-test/data-testid and their boxes, so findings can point at them. */
async function markableElements(page: PlaywrightPage): Promise<Record<string, Box>> {
  return page.evaluate((max) => {
    const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
    Array.from(document.querySelectorAll('[data-test],[data-testid]'))
      .slice(0, max)
      .forEach((el) => {
        const key = el.getAttribute('data-test') || el.getAttribute('data-testid');
        if (!key || boxes[key]) return;
        const r = el.getBoundingClientRect();
        const tooSmall = r.width < 2 || r.height < 2;
        const offScreen = r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth;
        if (tooSmall || offScreen) return;
        boxes[key] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      });
    return boxes;
  }, MAX_MARKED_ELEMENTS);
}

/** Runs axe with the topic's rules and keeps what the report needs, with on-screen boxes. */
async function auditWithAxe(page: PlaywrightPage): Promise<Pick<StateRecord, 'violations' | 'incomplete' | 'passes'>> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return {
    violations: await summarizeRules(page, results.violations),
    incomplete: await summarizeRules(page, results.incomplete),
    passes: results.passes.map((rule) => ({
      id: rule.id,
      help: rule.help,
      tags: rule.tags.filter((tag) => tag.startsWith('wcag')),
      nodeCount: rule.nodes.length,
    })),
  };
}

/** Collects the states, checks and announcements of one scenario and writes them as one JSON. */
export class AuditRecorder {
  private readonly states: StateRecord[] = [];

  private readonly checks: Record<string, unknown> = {};

  private readonly announcements: Announcement[] = [];

  private readonly shotsDir: string;

  constructor(
    private readonly scenario: ScenarioInfo,
    private readonly outDir: string,
  ) {
    this.shotsDir = join(outDir, 'shots');
    mkdirSync(this.shotsDir, { recursive: true });
    mkdirSync(join(outDir, 'aria'), { recursive: true });
  }

  /**
   * Opens a state with `enter`, runs axe on it, captures the screen, then runs `leave`.
   * Returns whether the state was audited. A state that failed to open still gets its screenshot
   * (it shows what was on screen instead) and is closed with Escape, so whatever it left half open
   * does not cover the next states.
   */
  async state(page: PlaywrightPage, options: StateOptions): Promise<boolean> {
    const { id, name, description, actor = this.scenario.actors[0], enter, leave } = options;
    const record: StateRecord = { id, name, description, actor, ok: false };
    try {
      if (enter) await enter();
      await settle(page);
      Object.assign(record, await auditWithAxe(page), { ok: true });
    } catch (err) {
      record.error = errorMessage(err, { lines: 3, max: 500 });
    }
    Object.assign(record, await this.capture(page, `${this.scenario.id}--${id}`));
    this.states.push(record);
    try {
      if (leave) await leave();
    } catch {
      await pressEscape(page);
    }
    if (!record.ok) await pressEscape(page);
    return record.ok;
  }

  /**
   * Screenshot, viewport, URL, language, markable elements and accessibility tree. Best effort: on
   * failure it keeps what it got so far, since the axe result matters more than the picture.
   */
  private async capture(page: PlaywrightPage, file: string): Promise<Partial<StateRecord>> {
    const captured: Partial<StateRecord> = {};
    try {
      await page.screenshot({ path: join(this.shotsDir, `${file}.jpg`), type: 'jpeg', quality: SCREENSHOT_QUALITY });
      captured.shot = `shots/${file}.jpg`;
      captured.viewport = page.viewportSize() || undefined;
      captured.url = page.url().replace(/sessionToken=[^&]+/, 'sessionToken=…');
      captured.lang = await page.evaluate(() => document.documentElement.lang);
      captured.elements = await markableElements(page);
      if (wants(...ARIA_SNAPSHOT_TOPICS)) {
        const tree = await page.locator('body').ariaSnapshot({ timeout: ARIA_SNAPSHOT_TIMEOUT });
        captured.aria = `aria/${file}.yml`;
        writeFileSync(join(this.outDir, captured.aria), tree);
      }
    } catch {
      // keep the partial capture
    }
    return captured;
  }

  /** Runs a check; with a topic set, checks whose `topics` do not overlap it are recorded as skipped. */
  async check(id: string, run: () => Promise<unknown>, topics: string[] = []) {
    if (topics.length && !wants(...topics)) {
      this.checks[id] = { skipped: `fora do tópico (${GUIDELINES.join(', ')})` };
      return;
    }
    try {
      this.checks[id] = await run();
    } catch (err) {
      this.checks[id] = { error: errorMessage(err, { max: 500 }) };
    }
  }

  /** Pulls the live-region log recorded on `page` since the last call, attributed to `actor`. */
  async collectAnnouncements(page: PlaywrightPage, actor: string) {
    await waitForAlertQueue(page);
    const base = { t: Date.now(), actor, politeness: 'none', text: '', region: '', regionCreatedWithMessage: false };
    const read = await page
      .evaluate(() => {
        const pageWindow = window as unknown as { a11yAuditLog?: unknown[] };
        if (!Array.isArray(pageWindow.a11yAuditLog)) return { installed: false, items: [] as unknown[] };
        const items = pageWindow.a11yAuditLog;
        pageWindow.a11yAuditLog = [];
        return { installed: true, items };
      })
      .catch((err) => ({ installed: false, items: [] as unknown[], error: String(err).slice(0, 200) }));

    if (!read.installed) {
      // Never report this as silence: the recorder was missing or the page could not be read.
      const reason = 'error' in read ? read.error : 'recorder not installed';
      this.announcements.push({ ...base, unavailable: true, text: reason });
    } else if (!read.items.length) {
      // Silent moments are explicit: an expected announcement that never came is a finding candidate.
      this.announcements.push({ ...base, none: true });
    } else {
      (read.items as Omit<Announcement, 'actor'>[]).forEach((item) => this.announcements.push({ ...item, actor }));
    }
  }

  /** Stores a free-form fact about the scenario (a version, an error, a measurement). */
  note(id: string, value: unknown) {
    this.checks[id] = value;
  }

  write() {
    const data = {
      ...this.scenario,
      generatedAt: new Date().toISOString(),
      axeTags: AXE_TAGS,
      topic: GUIDELINES,
      states: this.states,
      checks: this.checks,
      announcements: this.announcements,
    };
    writeFileSync(join(this.outDir, `${this.scenario.id}.json`), JSON.stringify(data, null, 2));
    return data;
  }
}

export function auditOutDir(fallback: string) {
  const dir = process.env.A11Y_AUDIT_DIR || fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
}
