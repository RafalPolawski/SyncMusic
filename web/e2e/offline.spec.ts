import { expect, test } from '@playwright/test';
import { debug, expectPlaying, join, openFolder, phone } from './helpers';

test('keeps playing and advancing tracks while offline, then resyncs', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await join(page, 'Ala', 'offline-test');
  await openFolder(page, 'Krótkie');
  await page.getByRole('button', { name: 'Odtwórz' }).first().click();
  await expectPlaying(page);

  // Upcoming tracks are prefetched for offline use.
  await expect.poll(async () => (await debug(page)).downloaded.length).toBeGreaterThanOrEqual(2);
  const first = (await debug(page)).trackId;

  await ctx.setOffline(true);
  await expect.poll(async () => (await debug(page)).status, { timeout: 30_000 }).not.toBe('online');

  // Without any server the phone still moves on to the next track on time.
  await expect.poll(async () => (await debug(page)).trackId, { timeout: 15_000 }).not.toBe(first);
  const offline = await expectPlaying(page);
  expect(Math.abs(offline.elementMs - offline.targetMs)).toBeLessThan(400);

  await ctx.setOffline(false);
  await expect.poll(async () => (await debug(page)).status, { timeout: 30_000 }).toBe('online');
  await page.waitForTimeout(1000);
  const back = await debug(page);
  expect(Math.abs(back.elementMs - back.targetMs)).toBeLessThan(400);
  await ctx.close();
});

test('the app opens offline after it was used once', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await join(page, 'Ala', 'offline-start');
  // Wait for the service worker to take control so the shell is cached.
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker?.controller !== null)).toBe(true);
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator('.tile').first()).toBeVisible();
  await expect(page.locator('.badge')).toBeVisible();
  await ctx.close();
});
