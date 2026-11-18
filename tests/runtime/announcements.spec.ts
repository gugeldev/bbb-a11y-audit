import { expect, Page, test } from '@playwright/test';

import {
  announcementRecorderScript,
  clearAnnouncements,
  ensureAnnouncementRecorder,
  installAnnouncementRecorder,
  waitForAlertQueue,
} from '../../bbb-a11y-audit/runtime/wcagAuditAnnouncements';

type Logged = { t: number; [key: string]: unknown };

/**
 * Applies a DOM change and waits long enough for the recorder to tell it apart from the next one.
 * `update` runs in the browser: it can only use the DOM, not variables from this file.
 */
async function change(page: Page, update: () => void) {
  await page.evaluate(update);
  await page.waitForTimeout(200);
}

/** Reads and empties the log the same way AuditRecorder.collectAnnouncements does. */
function drain(page: Page) {
  return page.evaluate(() => {
    const pageWindow = window as unknown as { a11yAuditLog: Logged[] };
    const items = pageWindow.a11yAuditLog.map(({ t, ...rest }) => rest);
    pageWindow.a11yAuditLog = [];
    return items;
  });
}

test.beforeEach(async ({ context, page }) => {
  await installAnnouncementRecorder(context);
  await page.goto('data:text/html,<html><body></body></html>');
  await change(page, () => {
    document.body.innerHTML =
      '<div id="status" role="status"></div><div id="log" aria-live="polite"><p>first</p></div><div id="off" aria-live="off"></div>';
  });
  await clearAnnouncements(page);
});

test('records new text in a region, once, and ignores regions that are off', async ({ page }) => {
  await change(page, () => (document.getElementById('status')!.textContent = 'Saved'));
  await change(page, () => (document.getElementById('status')!.textContent = 'Saved'));
  await change(page, () => (document.getElementById('off')!.textContent = 'ignored'));
  expect(await drain(page)).toEqual([
    {
      politeness: 'polite',
      role: 'status',
      text: 'Saved',
      region: 'div#status[role=status]',
      regionCreatedWithMessage: false,
    },
  ]);
});

test('records only what was added to a growing region, and nothing when it shrinks', async ({ page }) => {
  await change(page, () => document.getElementById('log')!.insertAdjacentHTML('beforeend', '<p>second</p>'));
  await change(page, () => document.getElementById('log')!.insertAdjacentHTML('afterbegin', '<p>zero</p>'));
  await change(page, () => document.getElementById('log')!.firstElementChild!.remove());
  expect((await drain(page)).map((item) => item.text)).toEqual(['second', 'zero']);
});

test('records the same message again after the region was emptied', async ({ page }) => {
  await change(page, () => (document.getElementById('status')!.textContent = 'Saved'));
  await change(page, () => (document.getElementById('status')!.textContent = ''));
  await change(page, () => (document.getElementById('status')!.textContent = 'Saved'));
  expect((await drain(page)).map((item) => item.text)).toEqual(['Saved', 'Saved']);
});

test('flags regions inserted together with their message, except role=alert', async ({ page }) => {
  await change(page, () =>
    document.body.insertAdjacentHTML('beforeend', '<div role="status" data-test="toast">Joined</div>'),
  );
  await change(page, () => document.body.insertAdjacentHTML('beforeend', '<div role="alert">Error!</div>'));
  expect(await drain(page)).toEqual([
    expect.objectContaining({
      text: 'Joined',
      region: 'div[data-test=toast][role=status]',
      regionCreatedWithMessage: true,
    }),
    expect.objectContaining({ text: 'Error!', politeness: 'assertive', regionCreatedWithMessage: false }),
  ]);
});

test('records nested regions once, at the outermost region touched', async ({ page }) => {
  await change(page, () =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<section aria-live="assertive"><span role="status">Nested   message</span></section>',
    ),
  );
  expect(await drain(page)).toEqual([
    expect.objectContaining({ text: 'Nested message', region: 'section', politeness: 'assertive' }),
  ]);
});

test('keeps recording after the log is drained, and installs only once per document', async ({ page }) => {
  expect(await ensureAnnouncementRecorder(page)).toBe(true);
  await page.evaluate(announcementRecorderScript);
  await change(page, () => (document.getElementById('status')!.textContent = 'One'));
  expect(await drain(page)).toHaveLength(1);
  await change(page, () => (document.getElementById('status')!.textContent = 'x'.repeat(300)));
  const [long] = await drain(page);
  expect(long.text).toHaveLength(240);
});

test('can be installed into a page that is already loaded', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('data:text/html,<div id="s" role="status"></div>');
  expect(await ensureAnnouncementRecorder(page)).toBe(false);
  await change(page, () => (document.getElementById('s')!.textContent = 'Late'));
  expect((await drain(page)).map((item) => item.text)).toEqual(['Late']);
  await page.close();
});

test('waits for the client announcer to finish its queue before collecting', async ({ page }) => {
  // Like screenreader-alert: one message stays in #aria-polite-alert, then the region empties.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="aria-polite-alert" aria-live="polite">Queued</div>');
    setTimeout(() => (document.getElementById('aria-polite-alert')!.textContent = ''), 1500);
  });
  const started = Date.now();
  await waitForAlertQueue(page);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(await page.locator('#aria-polite-alert').textContent()).toBe('');
});
