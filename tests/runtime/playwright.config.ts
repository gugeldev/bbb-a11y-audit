import { defineConfig } from '@playwright/test';

/**
 * Tests for the runtime helpers of the skill (bbb-a11y-audit/runtime), against local fixture pages.
 * They do not need a BigBlueButton server. Uses the installed Google Chrome (`npx playwright install chrome`).
 */
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  reporter: 'list',
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 800, height: 600 },
    // The BigBlueButton suite sets an action timeout too; without one a missing element waits forever.
    actionTimeout: 3000,
  },
});
