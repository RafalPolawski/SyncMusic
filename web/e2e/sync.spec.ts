import { expect, test } from '@playwright/test';
import { debug, expectPlaying, join, openFolder, phone } from './helpers';

test('two phones play the same track in sync and share pause', async ({ browser }) => {
  const a = await phone(browser);
  const b = await phone(browser);
  await join(a.page, 'Ala', 'sync-test');
  await join(b.page, 'Bartek', 'sync-test');

  await openFolder(a.page, 'Siłownia');
  await a.page.getByRole('button', { name: 'Odtwórz' }).first().click();

  await expectPlaying(a.page);
  await expectPlaying(b.page);
  await expect(b.page.locator('.mini-title')).toHaveText('Rozgrzewka');

  // Give the drift controllers a few seconds to converge, then measure.
  await a.page.waitForTimeout(5000);
  for (let i = 0; i < 5; i++) {
    const [da, db] = await Promise.all([debug(a.page), debug(b.page)]);
    expect(da.trackId).toBe(db.trackId);
    expect(Math.abs(da.elementMs - da.targetMs), 'A follows the room timeline').toBeLessThan(80);
    expect(Math.abs(db.elementMs - db.targetMs), 'B follows the room timeline').toBeLessThan(80);
    // Position relative to the shared server clock, so sampling skew cancels out.
    const skew = Math.abs(da.elementMs - da.serverNow - (db.elementMs - db.serverNow));
    expect(skew, 'phones are aligned with each other').toBeLessThan(80);
    await a.page.waitForTimeout(400);
  }

  // Pausing on one phone pauses the other.
  await b.page.locator('.mini-player .play-btn').click();
  await expect.poll(async () => (await debug(a.page)).paused).toBe(true);
  await expect.poll(async () => (await debug(b.page)).paused).toBe(true);

  // Resuming continues from the same position on both.
  const pausedAt = (await debug(a.page)).targetMs;
  await a.page.locator('.mini-player .play-btn').click();
  const resumed = await expectPlaying(b.page);
  expect(resumed.elementMs).toBeGreaterThanOrEqual(pausedAt - 500);

  // Presence lists both listeners.
  await a.page.locator('.mini-row').click();
  await expect(a.page.locator('.listener')).toHaveCount(2);
  await expect(a.page.locator('.listener-name', { hasText: 'Bartek' })).toBeVisible();

  await a.ctx.close();
  await b.ctx.close();
});

test('a phone joining later starts at the current position', async ({ browser }) => {
  const a = await phone(browser);
  await join(a.page, 'Ala', 'late-join');
  await openFolder(a.page, 'Siłownia');
  await a.page.getByRole('button', { name: 'Odtwórz' }).first().click();
  await expectPlaying(a.page);
  await a.page.waitForTimeout(4000);

  const b = await phone(browser);
  await join(b.page, 'Cezary', 'late-join');
  const db = await expectPlaying(b.page);
  expect(db.elementMs).toBeGreaterThan(3000);
  await b.page.waitForTimeout(3000);
  const [x, y] = await Promise.all([debug(a.page), debug(b.page)]);
  expect(Math.abs(x.elementMs - x.serverNow - (y.elementMs - y.serverNow))).toBeLessThan(100);

  await a.ctx.close();
  await b.ctx.close();
});
