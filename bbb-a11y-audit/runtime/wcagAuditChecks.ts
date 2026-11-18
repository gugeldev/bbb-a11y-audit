import { Page as PlaywrightPage } from '@playwright/test';

import { Box, errorMessage, pressEscape, settle } from './wcagAuditRecorder';

/**
 * Custom checks of the runtime layer: what axe-core cannot see because it needs the page to be
 * resized, restyled, typed into or walked with the keyboard. Each check returns raw data; the agent
 * decides whether it is a finding. Code inside `page.evaluate` runs in the browser and must not use
 * anything from this module.
 */

const REFLOW_WIDTH = 320;
const MAX_REFLOW_OFFENDERS = 15;
const MAX_CLIPPED = 25;
const TOOLTIP_DELAY_MS = 700;

// WCAG 1.4.12 minimum spacing the content must survive.
const TEXT_SPACING_CSS = `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p { margin-bottom: 2em !important; }`;

// ARIA attributes that expose name, role and state (4.1.2), compared before and after an action.
const STATE_ATTRIBUTES = [
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
const SELECTION_ATTRIBUTES = ['role', 'aria-checked', 'aria-selected', 'aria-current', 'aria-label'];
const TOOLTIP_SELECTORS = ['[role="tooltip"]', '[data-tippy-root]', '.MuiTooltip-popper'];

/**
 * Runs a check that opens something from `trigger`. On failure, closes whatever is open with Escape
 * (so the next check starts clean) and returns the error in place of the result.
 */
async function fromTrigger<T extends object>(page: PlaywrightPage, trigger: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (err) {
    await pressEscape(page);
    return { trigger, error: errorMessage(err) };
  }
}

/** 1.4.10 Reflow: at 320 CSS px wide nothing should need horizontal scrolling. */
export async function checkReflow(page: PlaywrightPage) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: REFLOW_WIDTH, height: 800 });
  await settle(page, 2);
  const result = await page.evaluate((maxOffenders) => {
    const overflowing = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.right > window.innerWidth + 1 && getComputedStyle(el).visibility !== 'hidden';
    });
    // Only the outermost element of each overflowing subtree: its children overflow because of it.
    const offenders = overflowing
      .filter((el) => !overflowing.some((other) => other !== el && other.contains(el)))
      .slice(0, maxOffenders)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || undefined,
        className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
        right: Math.round(el.getBoundingClientRect().right),
      }));
    return { viewportWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  }, MAX_REFLOW_OFFENDERS);
  if (original) await page.setViewportSize(original);
  await settle(page);
  return { ...result, horizontalScroll: result.scrollWidth > result.viewportWidth + 1 };
}

/** Elements that clip their own text: overflow hidden or clip, and content larger than the box. */
function findClippedText(page: PlaywrightPage) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => {
        const style = getComputedStyle(el);
        const clips = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY);
        const hasText = Array.from(el.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0,
        );
        const overflows = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        return clips && hasText && el.offsetParent !== null && overflows;
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
}

/** 1.4.12 Text Spacing: apply the WCAG spacing and list text that becomes clipped because of it. */
export async function checkTextSpacing(page: PlaywrightPage) {
  const before = await findClippedText(page);
  const spacing = await page.addStyleTag({ content: TEXT_SPACING_CSS });
  await settle(page);
  const after = await findClippedText(page);
  await spacing.evaluate((node) => (node as HTMLElement).remove());
  await settle(page);

  const identity = (item: { tag: string; className?: string; text: string }) =>
    `${item.tag}|${item.className}|${item.text}`;
  const clippedBefore = new Set(before.map(identity));
  return { newlyClipped: after.filter((item) => !clippedBefore.has(identity(item))).slice(0, MAX_CLIPPED) };
}

/** State attributes of the element at `selector`, or of whatever now sits where it was (buttons often swap). */
async function stateAt(page: PlaywrightPage, selector: string, fallback?: Box | null) {
  return page.evaluate(
    ({ sel, attributes, box }) => {
      let el = document.querySelector(sel) as HTMLElement | null;
      if (!el && box) {
        const hit = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2);
        el = (hit?.closest('button,[role],a,input') as HTMLElement | null) || null;
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const state: Record<string, string | null> = {
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
      attributes.forEach((attribute) => {
        state[attribute] = el!.getAttribute(attribute);
      });
      return state;
    },
    { sel: selector, attributes: STATE_ATTRIBUTES, box: fallback || null },
  );
}

/**
 * 4.1.2 states: activate a toggle or a menu trigger and report which ARIA attributes changed.
 * A toggle that changes visually but not in ARIA fails 4.1.2.
 */
export async function checkStateChange(page: PlaywrightPage, trigger: string, restore: 'click' | 'escape') {
  return fromTrigger(page, trigger, async () => {
    const before = await stateAt(page, trigger);
    if (!before) throw new Error('trigger not found');
    const box = before.box ? (JSON.parse(before.box) as Box) : null;
    await page.locator(trigger).first().click();
    await settle(page);
    const after = await stateAt(page, trigger, box);
    const changedAttributes = STATE_ATTRIBUTES.filter((a) => (before[a] ?? null) !== (after?.[a] ?? null));

    if (restore === 'escape') await page.keyboard.press('Escape');
    else if (after?.dataTest) await page.locator(`[data-test="${after.dataTest}"]`).first().click();
    else await page.locator(trigger).first().click();
    await settle(page);
    return { trigger, before, after, changedAttributes, swappedElement: before.dataTest !== after?.dataTest };
  });
}

/** Items matching `itemSelector` with how each exposes being the current choice. */
function readMenuItems(page: PlaywrightPage, itemSelector: string) {
  return page.evaluate(
    ({ sel, attributes }) =>
      Array.from(document.querySelectorAll(sel)).map((el) => {
        const item: Record<string, string | null> = {
          id: el.id || null,
          text: (el.textContent || '').trim().slice(0, 60),
        };
        attributes.forEach((attribute) => {
          item[attribute] = el.getAttribute(attribute);
        });
        // Text a screen reader also gets: aria-describedby targets and visually hidden spans.
        item.describedBy = (el.getAttribute('aria-describedby') || '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() || `(missing id ${id})`)
          .join(' | ');
        return item;
      }),
    { sel: itemSelector, attributes: SELECTION_ATTRIBUTES },
  );
}

/**
 * 4.1.2 selection: open a menu, pick a different item, reopen it and report how the current choice
 * is exposed (aria-checked / aria-selected / aria-current / role) before and after.
 */
export async function checkMenuSelection(page: PlaywrightPage, trigger: string, itemSelector: string) {
  return fromTrigger(page, trigger, async () => {
    await page.locator(trigger).first().click();
    await settle(page);
    const before = await readMenuItems(page, itemSelector);
    const items = page.locator(itemSelector);
    if ((await items.count()) < 2) throw new Error(`fewer than two items match ${itemSelector}`);
    const target = items.nth(1);
    const picked = ((await target.textContent()) || '').trim().slice(0, 60);
    await target.click();
    await settle(page, 2);
    await page.keyboard.press('Escape');
    await page.locator(trigger).first().click();
    await settle(page);
    const after = await readMenuItems(page, itemSelector);
    await page.keyboard.press('Escape');
    return { trigger, picked, before, after };
  });
}

function describeFocused(page: PlaywrightPage) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'body';
    const dataTest = active.getAttribute('data-test') || active.getAttribute('data-testid');
    return `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}${dataTest ? `[data-test=${dataTest}]` : ''}`;
  });
}

/**
 * 2.4.3 Focus Order: open a menu or modal from its trigger with the keyboard, close it with Escape,
 * and report where focus went. Focus should come back to the trigger.
 */
export async function checkFocusReturn(page: PlaywrightPage, trigger: string) {
  return fromTrigger(page, trigger, async () => {
    const triggerElement = page.locator(trigger).first();
    await triggerElement.focus();
    const triggerFocusable = await triggerElement.evaluate((el) => el === document.activeElement);
    await page.keyboard.press('Enter');
    await settle(page);
    const focusAfterOpen = await describeFocused(page);
    await page.keyboard.press('Escape');
    await settle(page);
    const returnedToTrigger = await triggerElement.evaluate(
      (el) => el === document.activeElement || el.contains(document.activeElement),
    );
    return {
      trigger,
      triggerFocusable,
      focusAfterOpen,
      returnedToTrigger,
      focusAfterClose: await describeFocused(page),
    };
  });
}

/**
 * 1.4.13 Content on Hover or Focus: for each trigger, check that its tooltip appears on hover and on
 * keyboard focus, that Escape dismisses it without moving the pointer, and that it stays while the
 * pointer moves onto it. Tooltips already on screen before the hover (persistent hints) are ignored.
 */
export async function checkHoverFocus(page: PlaywrightPage, triggers: string[]) {
  const newTooltips = page.locator(TOOLTIP_SELECTORS.map((s) => `${s}:not([data-a11y-pre]):visible`).join(', '));
  const markTooltipsOnScreen = () =>
    page.evaluate((selectors) => {
      document.querySelectorAll('[data-a11y-pre]').forEach((el) => el.removeAttribute('data-a11y-pre'));
      document.querySelectorAll(selectors.join(',')).forEach((el) => el.setAttribute('data-a11y-pre', '1'));
    }, TOOLTIP_SELECTORS);
  const tooltipShown = async () => (await newTooltips.count()) > 0;
  const waitTooltipGone = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while ((await tooltipShown()) && Date.now() < deadline) await page.waitForTimeout(100);
    return !(await tooltipShown());
  };
  const reset = async () => {
    await page.mouse.move(1, 1);
    await page.keyboard.press('Escape');
    await waitTooltipGone(1500);
    await page.waitForTimeout(300);
    await markTooltipsOnScreen();
  };

  const results: Array<Record<string, unknown>> = [];
  for (const trigger of triggers) {
    const result: Record<string, unknown> = { trigger };
    try {
      const triggerElement = page.locator(trigger).first();
      if (!(await triggerElement.isVisible())) throw new Error('trigger not visible');

      await reset();
      await triggerElement.hover();
      await page.waitForTimeout(TOOLTIP_DELAY_MS);
      result.appearsOnHover = await tooltipShown();
      if (result.appearsOnHover) {
        result.text = ((await newTooltips.first().textContent()) || '').trim().slice(0, 80);
        await page.keyboard.press('Escape');
        result.dismissibleWithEscape = await waitTooltipGone(1000);

        await reset();
        await triggerElement.hover();
        await page.waitForTimeout(TOOLTIP_DELAY_MS);
        const tooltip = await newTooltips.first().boundingBox();
        if (tooltip) {
          await page.mouse.move(tooltip.x + tooltip.width / 2, tooltip.y + tooltip.height / 2, { steps: 8 });
          await page.waitForTimeout(500);
          result.hoverable = await tooltipShown();
        }
      }

      await reset();
      await triggerElement.focus();
      await page.waitForTimeout(TOOLTIP_DELAY_MS);
      result.appearsOnFocus = await tooltipShown();
    } catch (err) {
      result.error = errorMessage(err);
    }
    results.push(result);
  }
  await page.mouse.move(1, 1);
  await page.keyboard.press('Escape');
  return results;
}

/** Describes the focused element: name, box, and the candidate problems of 2.4.7 and 2.4.11. */
function describeFocusStop(page: PlaywrightPage) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: 'body' } as Record<string, unknown>;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const onTop = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const visible = rect.width > 0 && rect.height > 0;
    const labelledBy = el.getAttribute('aria-labelledby');
    const name =
      el.getAttribute('aria-label') ||
      (labelledBy && document.getElementById(labelledBy)?.textContent) ||
      el.textContent ||
      el.getAttribute('title') ||
      (el as HTMLInputElement).placeholder ||
      '';
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      name: name.trim().slice(0, 60),
      dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || undefined,
      id: el.id || undefined,
      visible,
      box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      // Candidate only: focus may still show through background, border or a child.
      noOutlineOrShadow: (style.outlineStyle === 'none' || style.outlineWidth === '0px') && style.boxShadow === 'none',
      obscured: visible && !!onTop && onTop !== el && !el.contains(onTop) && !onTop.contains(el),
      signature: `${el.tagName}|${el.id}|${el.getAttribute('data-test')}|${Math.round(rect.left)},${Math.round(rect.top)}`,
    } as Record<string, unknown>;
  });
}

/**
 * 2.1.1 / 2.1.2 / 2.4.3 / 2.4.7 / 2.4.11: walk the page with Tab and describe every focus stop.
 * Stops when focus comes back to the first stop (a full cycle) or stays on the same element for
 * three presses in a row (a possible keyboard trap).
 */
export async function checkKeyboard(page: PlaywrightPage, maxStops = 80) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: Array<Record<string, unknown>> = [];
  let possibleTrap = false;

  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    const stop = await describeFocusStop(page);
    const lastTwo = stops.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((s) => s.signature && s.signature === stop.signature)) {
      possibleTrap = true;
      stops.push(stop);
      break;
    }
    if (stops.length > 3 && stop.signature && stop.signature === stops[0].signature) break;
    stops.push(stop);
  }
  return { stopCount: stops.length, possibleTrap, stops };
}
