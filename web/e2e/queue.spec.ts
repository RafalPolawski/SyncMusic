import { expect, test } from '@playwright/test';
import { debug, expectPlaying, freshRoom, join, openFolder, phone } from './helpers';

test('queued tracks are shared and play next', async ({ browser }) => {
  const a = await phone(browser);
  const b = await phone(browser);
  const room = freshRoom('queue-test');
  await join(a.page, 'Ala', room);
  await join(b.page, 'Bartek', room);

  await openFolder(a.page, 'Siłownia');
  await a.page.getByRole('button', { name: 'Odtwórz' }).first().click();
  await expectPlaying(b.page);

  // Bartek finds a track and queues it to play next.
  await b.page.getByRole('button', { name: 'Szukaj' }).click();
  await b.page.getByPlaceholder('Tytuł, wykonawca, album, folder').fill('luzny');
  const row = b.page.locator('.track-row', { hasText: 'Luźny' });
  await row.getByRole('button', { name: '⋯' }).click();
  await b.page.getByRole('button', { name: 'Zagraj jako następny' }).click();

  // Ala sees it in her queue, with who added it.
  await a.page.getByRole('button', { name: 'Kolejka' }).click();
  await expect(a.page.locator('.queue-row', { hasText: 'Luźny' })).toContainText('Bartek');

  // Skipping plays the queued track on both phones.
  await a.page.locator('.mini-row').click();
  await a.page.getByRole('button', { name: 'Następny' }).click();
  await expect(b.page.locator('.mini-title')).toHaveText('Luźny');
  await expect(a.page.locator('.np-title h2')).toHaveText('Luźny');
  await expect.poll(async () => (await debug(b.page)).trackId).toBe((await debug(a.page)).trackId);

  await a.ctx.close();
  await b.ctx.close();
});
