import { expect, test } from '@playwright/test';

test('rejects a wrong password and accepts the right one', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Twoje imię').fill('Ala');
  await page.getByLabel('Hasło serwera').fill('wrong');
  await page.getByRole('button', { name: 'Dołącz' }).click();
  await expect(page.getByRole('alert')).toHaveText('Nieprawidłowe hasło');
  await page.getByLabel('Hasło serwera').fill('e2e-secret');
  await page.getByRole('button', { name: 'Dołącz' }).click();
  await expect(page.locator('.tile').first()).toBeVisible();
  // The session survives a reload.
  await page.reload();
  await expect(page.locator('.tile').first()).toBeVisible();
});
