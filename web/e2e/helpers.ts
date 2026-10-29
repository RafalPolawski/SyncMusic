import { expect, type Browser, type BrowserContext, type Page, devices } from '@playwright/test';

export interface Debug {
  serverNow: number;
  trackId: string;
  targetMs: number;
  elementMs: number;
  paused: boolean;
  playing: boolean;
  offsetMs?: number;
  rttMs?: number;
  status: string;
  downloaded: string[];
}

export const PASSWORD = 'e2e-secret';

export async function phone(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'pl-PL' });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** A room name not used by any earlier test run against the same server. */
export function freshRoom(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export async function join(page: Page, name: string, room: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Twoje imię').fill(name);
  await page.getByLabel('Pokój').fill(room);
  await page.getByLabel('Hasło serwera').fill(PASSWORD);
  await page.getByRole('button', { name: 'Dołącz' }).click();
  await expect(page.locator('.tile').first()).toBeVisible();
  await expect.poll(async () => (await debug(page)).status).toBe('online');
}

export function debug(page: Page): Promise<Debug> {
  return page.evaluate(() => (window as unknown as { __syncmusic: () => Debug }).__syncmusic());
}

export async function openFolder(page: Page, name: string): Promise<void> {
  await page.locator('.tile', { hasText: name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** Waits until the local element is audibly playing the room's track. */
export async function expectPlaying(page: Page): Promise<Debug> {
  await expect
    .poll(async () => {
      const d = await debug(page);
      return d.playing && !d.paused && d.elementMs > 0;
    })
    .toBe(true);
  return debug(page);
}

/** Waits until the element is within `toleranceMs` of the room timeline. */
export async function expectInSync(page: Page, toleranceMs = 400): Promise<void> {
  await expect
    .poll(async () => {
      const d = await debug(page);
      return d.playing && !d.paused ? Math.abs(d.elementMs - d.targetMs) : Infinity;
    })
    .toBeLessThan(toleranceMs);
}
