import { BrowserContext, Page as PlaywrightPage } from '@playwright/test';

/**
 * Records what would reach a screen reader through live regions (aria-live, role=status/alert/log),
 * so 4.1.3 Status Messages can be decided from data instead of by ear.
 *
 * Runs INSIDE the page (Playwright serializes the function), so it must not reference anything
 * outside its own body. Messages are pushed to `window.a11yAuditLog`; the AuditRecorder drains it.
 */
export function announcementRecorderScript() {
  const SELECTOR = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';
  // A region that appears this close to its message was inserted together with it.
  const INSERTED_WITH_MESSAGE_MS = 100;
  const MAX_TEXT = 240;

  const pageWindow = window as unknown as { a11yAuditLog?: unknown[]; a11yAuditRegionSeen?: WeakMap<Element, number> };
  // Mark the document, not the window: a tab opened by the app keeps its window object when it
  // navigates from the initial blank page, so a window flag would skip the real document.
  const pageDocument = document as unknown as { a11yAuditObserved?: boolean };
  if (pageDocument.a11yAuditObserved) return;
  pageDocument.a11yAuditObserved = true;
  if (!Array.isArray(pageWindow.a11yAuditLog)) pageWindow.a11yAuditLog = [];
  if (!pageWindow.a11yAuditRegionSeen) pageWindow.a11yAuditRegionSeen = new WeakMap();
  // Not cached: the recorder side replaces the array each time it drains or clears the log.
  const log = () => {
    if (!Array.isArray(pageWindow.a11yAuditLog)) pageWindow.a11yAuditLog = [];
    return pageWindow.a11yAuditLog;
  };
  const firstSeen = pageWindow.a11yAuditRegionSeen;
  const lastText = new WeakMap<Element, string>();

  const describe = (el: Element) => {
    const dataTest = el.getAttribute('data-test');
    const role = el.getAttribute('role');
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${dataTest ? `[data-test=${dataTest}]` : ''}${role ? `[role=${role}]` : ''}`;
  };

  /** Live regions touched by a batch of mutations: inserted ones and those whose content changed. */
  const touchedRegions = (mutations: MutationRecord[], now: number) => {
    const touched = new Set<Element>();
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        [el, ...Array.from(el.querySelectorAll(SELECTOR))].forEach((region) => {
          if (!region.matches(SELECTOR)) return;
          if (!firstSeen.has(region)) firstSeen.set(region, now);
          // A region inserted together with its text (React re-mounting it) also carries a message.
          touched.add(region);
        });
      });
      const target =
        mutation.target.nodeType === Node.ELEMENT_NODE ? (mutation.target as Element) : mutation.target.parentElement;
      const region = target?.closest(SELECTOR);
      if (region) touched.add(region);
    });
    // Nested live regions repeat the same text: keep only the outermost one touched in this batch.
    const all = Array.from(touched);
    return all.filter((region) => !all.some((other) => other !== region && other.contains(region)));
  };

  /** The part of the region's text that is new since the last time it was read, or '' if none. */
  const newText = (region: Element) => {
    const full = (region.textContent || '').replace(/\s+/g, ' ').trim();
    const previous = lastText.get(region) || '';
    lastText.set(region, full);
    // Emptied (old text forgotten, so the same message later counts again), unchanged, or shrunk
    // because something was removed (a toast closed): nothing new to announce.
    if (!full || full === previous || (previous && previous.includes(full))) return '';
    // Regions such as the chat log or the toast stack grow: keep only what was added.
    if (previous && full.startsWith(previous)) return full.slice(previous.length).trim();
    if (previous && full.endsWith(previous)) return full.slice(0, full.length - previous.length).trim();
    return full;
  };

  const record = (region: Element, text: string, now: number) => {
    const role = region.getAttribute('role') || undefined;
    const seen = firstSeen.get(region);
    log().push({
      t: now,
      politeness: region.getAttribute('aria-live') || (role === 'alert' ? 'assertive' : 'polite'),
      role,
      text: text.slice(0, MAX_TEXT),
      region: describe(region),
      // role=alert is announced when it is inserted, so only other regions risk being skipped.
      regionCreatedWithMessage: role !== 'alert' && seen !== undefined && now - seen < INSERTED_WITH_MESSAGE_MS,
    });
  };

  const start = () => {
    const observer = new MutationObserver((mutations) => {
      const now = Date.now();
      touchedRegions(mutations, now).forEach((region) => {
        const text = newText(region);
        if (text) record(region, text, now);
      });
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
}

/** Installs the recorder in every page of `context`, before the page's own scripts run. */
export async function installAnnouncementRecorder(context: BrowserContext) {
  await context.addInitScript(announcementRecorderScript);
}

/** Installs the recorder into a page that is already loaded (e.g. a tab opened by the app). */
export async function ensureAnnouncementRecorder(page: PlaywrightPage) {
  const installed = await page
    .evaluate(() => Boolean((document as unknown as { a11yAuditObserved?: boolean }).a11yAuditObserved))
    .catch(() => false);
  if (!installed) await page.evaluate(announcementRecorderScript);
  return installed;
}

// The client's global announcer (screenreader-alert) shows queued messages one at a time in this
// region, each for 15 s, so the messages of one interaction can keep arriving long after it.
const GLOBAL_ANNOUNCER = '#aria-polite-alert';
const ALERT_QUEUE_TIMEOUT = 60000;

/**
 * Waits until the global announcer has nothing left to say (its region is empty), so a moment's
 * messages are collected with that moment instead of leaking into the next one or being cleared.
 * Gives up after a minute: a message that never leaves is still recorded, just later.
 */
export async function waitForAlertQueue(page: PlaywrightPage) {
  await page
    .waitForFunction((region) => !document.querySelector(region)?.textContent?.trim(), GLOBAL_ANNOUNCER, {
      timeout: ALERT_QUEUE_TIMEOUT,
      polling: 500,
    })
    .catch(() => undefined);
}

/** Drops what was recorded on `page` so far (setup noise before an interaction). */
export async function clearAnnouncements(page: PlaywrightPage) {
  await waitForAlertQueue(page);
  await page
    .evaluate(() => {
      (window as unknown as { a11yAuditLog?: unknown[] }).a11yAuditLog = [];
    })
    .catch(() => undefined);
}
