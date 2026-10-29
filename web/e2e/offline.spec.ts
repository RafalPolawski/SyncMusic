import { expect, test } from '@playwright/test';
import { debug, expectInSync, expectPlaying, freshRoom, join, openFolder, phone } from './helpers';

test('keeps playing and advancing tracks while offline, then resyncs', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await join(page, 'Ala', freshRoom('offline-test'));
  await openFolder(page, 'Krótkie');
  await page.getByRole('button', { name: 'Odtwórz' }).first().click();
  await expectPlaying(page);

  // Loop the three short tracks so the room never runs out of music.
  await page.locator('.mini-row').click();
  await page.getByRole('button', { name: 'Bez powtarzania' }).click();
  await expect(page.getByRole('button', { name: 'Powtarzaj wszystko' })).toBeVisible();

  // The upcoming tracks, and after them the one playing now, are stored.
  await expect.poll(async () => (await debug(page)).downloaded.length).toBe(3);
  const first = (await debug(page)).trackId;

  await ctx.setOffline(true);
  await expect.poll(async () => (await debug(page)).status).not.toBe('online');

  // Without any server the phone still moves on to the next track on time.
  await expect.poll(async () => (await debug(page)).trackId, { timeout: 15_000 }).not.toBe(first);
  await expectPlaying(page);
  await expectInSync(page);

  await ctx.setOffline(false);
  await expect.poll(async () => (await debug(page)).status, { timeout: 30_000 }).toBe('online');
  await expectInSync(page);
  await ctx.close();
});

test('the app opens offline after it was used once', async ({ browser }) => {
  const { ctx, page } = await phone(browser);
  await join(page, 'Ala', freshRoom('offline-start'));
  // Wait for the service worker to take control so the shell is cached.
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker?.controller !== null)).toBe(true);
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator('.tile').first()).toBeVisible();
  await expect(page.locator('.badge')).toBeVisible();
  await ctx.close();
});
