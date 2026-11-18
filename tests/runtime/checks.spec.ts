import { expect, test } from '@playwright/test';

import {
  checkFocusReturn,
  checkHoverFocus,
  checkKeyboard,
  checkMenuSelection,
  checkReflow,
  checkStateChange,
  checkTextSpacing,
} from '../../bbb-a11y-audit/runtime/wcagAuditChecks';

test.beforeEach(async ({ page }) => {
  await page.goto(new URL('fixtures/controls.html', import.meta.url).href);
});

test('keyboard walk describes each stop, with focus-visibility and obscured candidates', async ({ page }) => {
  const result = await checkKeyboard(page, 20);
  const stop = (dataTest: string) => result.stops.find((s) => s.dataTest === dataTest);

  expect(result.possibleTrap).toBe(false);
  expect(stop('mute')).toMatchObject({ tag: 'button', name: 'Mute', noOutlineOrShadow: true, obscured: false });
  expect(stop('name')).toMatchObject({ tag: 'input', name: 'Your name', obscured: true });
  expect(result.stops.find((s) => s.tag === 'a')).toMatchObject({ name: '?' });
});

test('reflow reports horizontal scrolling at 320 px and the outermost offender', async ({ page }) => {
  const result = await checkReflow(page);
  expect(result.horizontalScroll).toBe(true);
  expect(result.offenders.map((o) => o.dataTest)).toEqual(['wide']);
  expect(page.viewportSize()).toEqual({ width: 800, height: 600 });
});

test('text spacing lists only text that WCAG spacing newly clips', async ({ page }) => {
  const { newlyClipped } = await checkTextSpacing(page);
  expect(newlyClipped.map((item) => item.text)).toEqual(['This text is short']);
});

test('state change reports which ARIA attributes changed, or that the element was swapped', async ({ page }) => {
  expect(await checkStateChange(page, '#mute', 'click')).toMatchObject({
    changedAttributes: ['aria-pressed'],
    swappedElement: false,
  });
  expect(await checkStateChange(page, '[data-test="raise"]', 'click')).toMatchObject({
    changedAttributes: [],
    swappedElement: true,
    after: { dataTest: 'lower' },
  });
  expect(await checkStateChange(page, '#trigger', 'escape')).toMatchObject({ changedAttributes: ['aria-expanded'] });
  expect(await checkStateChange(page, '#missing', 'escape')).toEqual({
    trigger: '#missing',
    error: 'Error: trigger not found',
  });
});

test('menu selection shows how the current choice is exposed before and after picking', async ({ page }) => {
  const result = await checkMenuSelection(page, '#trigger', '[role=menuitemradio]');
  expect(result).toMatchObject({ picked: 'Mic 2' });
  if (!('before' in result)) throw new Error(result.error);
  expect(result.before.map((item) => item['aria-checked'])).toEqual(['true', 'false']);
  expect(result.after.map((item) => item['aria-checked'])).toEqual(['false', 'true']);
  expect(result.after[1].describedBy).toBe('current | (missing id missing)');

  const tooFew = await checkMenuSelection(page, '#trigger', '#dev-1');
  expect(tooFew).toMatchObject({ error: 'Error: fewer than two items match #dev-1' });
});

test('focus return shows where focus lands after closing a menu with Escape', async ({ page }) => {
  expect(await checkFocusReturn(page, '#trigger')).toEqual({
    trigger: '#trigger',
    triggerFocusable: true,
    focusAfterOpen: 'div#dev-1',
    returnedToTrigger: false,
    focusAfterClose: 'body',
  });
});

test('hover and focus content: appears, dismisses with Escape and stays when hovered', async ({ page }) => {
  const [trigger, mute, missing] = await checkHoverFocus(page, ['#trigger', '#mute', '#missing']);
  expect(trigger).toMatchObject({
    appearsOnHover: true,
    text: 'Choose devices',
    dismissibleWithEscape: true,
    hoverable: true,
    appearsOnFocus: true,
  });
  expect(mute).toMatchObject({ appearsOnHover: false, appearsOnFocus: false });
  expect(missing).toEqual({ trigger: '#missing', error: 'Error: trigger not visible' });
});
