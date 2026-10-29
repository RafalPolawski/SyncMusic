// Generates the screenshots used in the README and the Polish guide from the
// real app: a demo library with generated cover art, a real server and three
// emulated Android phones listening in the same room.
//
//   npm run screenshots                # English and Polish
//   npm run screenshots -- pl          # one language
//   npm run screenshots -- banner      # only the banners, from existing screenshots
//
// Needs Go, ffmpeg with libmp3lame and drawtext, a font (Inter looks best)
// and Playwright's Chromium (PW_CHROMIUM=/path/to/chrome for another one).
// Images are written to docs/images/<lang>/. The English banner doubles as
// the repository's social preview (Settings → General → Social preview).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { en } from '../src/i18n/en.ts';
import { pl, type Messages } from '../src/i18n/pl.ts';

type Lang = 'en' | 'pl';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const work = resolve(here, '../test-results/screenshots');
const port = Number(process.env.SCREENSHOTS_PORT ?? 18091);
const base = `http://127.0.0.1:${port}`;
const PASSWORD = 'demo';

// ---- demo library ----------------------------------------------------------

type Style = 'gradient' | 'radial' | 'rings' | 'duotone' | 'poster' | 'halftone' | 'sun' | 'letter';

interface Cover {
  style: Style;
  colors: string[];
  lines: string[];
  small?: string;
}

interface DemoTrack {
  folder: 'gym' | 'running' | 'chill' | 'road' | '';
  title: string;
  artist: string;
  album: string;
  seconds: number;
  cover: Cover;
}

const folderNames: Record<Lang, Record<string, string>> = {
  en: { gym: 'Gym', running: 'Running', chill: 'Evening chill', road: 'Road trip', legDay: 'Leg day' },
  pl: {
    gym: 'Siłownia',
    running: 'Bieganie',
    chill: 'Wieczorny chill',
    road: 'W trasie',
    legDay: 'Dzień nóg',
  },
};

const people: Record<Lang, [string, string, string]> = {
  en: ['Alex', 'Sam', 'Jordan'],
  pl: ['Rafał', 'Ola', 'Kuba'],
};

const tracks: DemoTrack[] = [
  {
    folder: 'gym',
    title: 'Heavy Lifting',
    artist: 'Iron Pulse',
    album: 'Heavy Lifting',
    seconds: 222,
    cover: {
      style: 'poster',
      colors: ['#e04a2f', '#1d1d1d', '#f4efe6'],
      lines: ['IRON', 'PULSE'],
      small: 'heavy lifting',
    },
  },
  {
    folder: 'gym',
    title: 'Golden Hour',
    artist: 'Neon Harbor',
    album: 'Harbor Lights',
    seconds: 198,
    cover: {
      style: 'gradient',
      colors: ['#ff5f6d', '#ffc371', '#7b2ff7'],
      lines: ['GOLDEN', 'HOUR'],
      small: 'NEON HARBOR',
    },
  },
  {
    folder: 'gym',
    title: 'Deadlift Anthem',
    artist: 'Bass Lab',
    album: 'Low End Theory',
    seconds: 245,
    cover: { style: 'rings', colors: ['#0f1626', '#38e8a0'], lines: ['Low End', 'Theory'] },
  },
  {
    folder: 'gym',
    title: 'Overdrive',
    artist: 'Velvet Static',
    album: 'Overdrive',
    seconds: 207,
    cover: { style: 'duotone', colors: ['#1a0b3d', '#ff3d8b'], lines: ['OVERDRIVE'], small: 'velvet static' },
  },
  {
    folder: 'gym',
    title: 'Last Set',
    artist: 'Iron Pulse',
    album: 'Heavy Lifting',
    seconds: 178,
    cover: { style: 'letter', colors: ['#f2c14e', '#151515'], lines: ['I'], small: 'IRON PULSE · LAST SET' },
  },
  {
    folder: 'gym',
    title: 'Personal Best',
    artist: 'Kilo & The Plates',
    album: 'Personal Best',
    seconds: 231,
    cover: { style: 'halftone', colors: ['#101820', '#2ec4b6'], lines: ['PERSONAL', 'BEST'] },
  },
  {
    folder: 'running',
    title: 'Tempo Run',
    artist: 'Paper Planes',
    album: 'Tempo',
    seconds: 215,
    cover: {
      style: 'gradient',
      colors: ['#43e97b', '#38f9d7', '#0072ff'],
      lines: ['TEMPO'],
      small: 'PAPER PLANES',
    },
  },
  {
    folder: 'running',
    title: 'City Lights',
    artist: 'Neon Harbor',
    album: 'City Lights',
    seconds: 252,
    cover: { style: 'rings', colors: ['#1b0f2e', '#ff9e3d'], lines: ['City', 'Lights'] },
  },
  {
    folder: 'running',
    title: 'Second Wind',
    artist: 'Low Tide',
    album: 'Second Wind',
    seconds: 189,
    cover: {
      style: 'poster',
      colors: ['#2f6fe0', '#1d1d1d', '#eef3f8'],
      lines: ['LOW', 'TIDE'],
      small: 'second wind',
    },
  },
  {
    folder: 'running',
    title: 'Pace Yourself',
    artist: 'Velvet Static',
    album: 'Overdrive',
    seconds: 224,
    cover: { style: 'duotone', colors: ['#06281f', '#9ef01a'], lines: ['PACE'], small: 'velvet static' },
  },
  {
    folder: 'running',
    title: 'Finish Line',
    artist: 'Marathon Kids',
    album: 'Finish Line',
    seconds: 260,
    cover: {
      style: 'gradient',
      colors: ['#f7971e', '#ffd200', '#e8505b'],
      lines: ['FINISH', 'LINE'],
      small: 'MARATHON KIDS',
    },
  },
  {
    folder: 'chill',
    title: 'Afterglow',
    artist: 'Soft Waves',
    album: 'Afterglow',
    seconds: 271,
    cover: { style: 'sun', colors: ['#2b1055', '#d53369', '#ffb347', '#ff5e62'], lines: ['Afterglow'] },
  },
  {
    folder: 'chill',
    title: 'Slow Sunday',
    artist: 'Moss & Fern',
    album: 'Slow Sunday',
    seconds: 238,
    cover: { style: 'halftone', colors: ['#f1ede4', '#3a5a40'], lines: ['slow', 'sunday'] },
  },
  {
    folder: 'chill',
    title: 'Low Light',
    artist: 'Soft Waves',
    album: 'Afterglow',
    seconds: 202,
    cover: {
      style: 'radial',
      colors: ['#8e9eab', '#4b6cb7', '#182848'],
      lines: ['low light'],
      small: 'SOFT WAVES',
    },
  },
  {
    folder: 'chill',
    title: 'Night Bloom',
    artist: 'Lumen',
    album: 'Night Bloom',
    seconds: 286,
    cover: { style: 'duotone', colors: ['#0d1b2a', '#c77dff'], lines: ['NIGHT', 'BLOOM'] },
  },
  {
    folder: 'chill',
    title: 'Cedar',
    artist: 'Moss & Fern',
    album: 'Slow Sunday',
    seconds: 195,
    cover: { style: 'letter', colors: ['#3a5a40', '#dad7cd'], lines: ['C'], small: 'MOSS & FERN · CEDAR' },
  },
  {
    folder: 'road',
    title: 'Highway 9',
    artist: 'Night Drive Club',
    album: 'Night Drive',
    seconds: 228,
    cover: { style: 'sun', colors: ['#090979', '#00d4ff', '#ff00a0', '#ffd319'], lines: ['NIGHT', 'DRIVE'] },
  },
  {
    folder: 'road',
    title: 'Neon Mile',
    artist: 'Night Drive Club',
    album: 'Night Drive',
    seconds: 242,
    cover: { style: 'rings', colors: ['#14001f', '#ff00a0'], lines: ['Neon', 'Mile'] },
  },
  {
    folder: 'road',
    title: 'Open Road',
    artist: 'Desert Radio',
    album: 'Open Road',
    seconds: 216,
    cover: {
      style: 'gradient',
      colors: ['#c94b4b', '#4b134f', '#ffb88c'],
      lines: ['OPEN', 'ROAD'],
      small: 'DESERT RADIO',
    },
  },
  {
    folder: 'road',
    title: 'Window Down',
    artist: 'Paper Planes',
    album: 'Tempo',
    seconds: 191,
    cover: { style: 'halftone', colors: ['#fff3b0', '#e09f3e'], lines: ['WINDOW', 'DOWN'] },
  },
  {
    folder: 'road',
    title: 'Mirage',
    artist: 'Desert Radio',
    album: 'Open Road',
    seconds: 265,
    cover: { style: 'sun', colors: ['#3e1f47', '#f8b195', '#f67280', '#ffe08a'], lines: ['MIRAGE'] },
  },
  {
    folder: '',
    title: 'Static Heart',
    artist: 'Lumen',
    album: 'Static Heart',
    seconds: 210,
    cover: { style: 'duotone', colors: ['#2d0a0a', '#ff6b6b'], lines: ['STATIC', 'HEART'] },
  },
  {
    folder: '',
    title: 'Warm Up',
    artist: 'Kilo & The Plates',
    album: 'Personal Best',
    seconds: 165,
    cover: {
      style: 'poster',
      colors: ['#2ec4b6', '#101820', '#f6f7f2'],
      lines: ['WARM', 'UP'],
      small: 'kilo & the plates',
    },
  },
];

/** Leg day: a playlist mixing Gym (downloaded in the screenshots) and Running. */
const legDay = [
  'Heavy Lifting',
  'Tempo Run',
  'Deadlift Anthem',
  'Second Wind',
  'Personal Best',
  'Finish Line',
];

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function dark(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** geq expressions mixing two colours by v (an expression in 0..1). */
function mix(a: string, b: string, v: string): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const ch = (x: number, y: number) => `'${x}+(${y - x})*(${v})'`;
  return `geq=r=${ch(ar, br)}:g=${ch(ag, bg)}:b=${ch(ab, bb)}`;
}

function fontFile(pattern: string): string | undefined {
  try {
    const f = execFileSync('fc-match', ['-f', '%{file}', pattern], { encoding: 'utf8' }).trim();
    return f && existsSync(f) ? f : undefined;
  } catch {
    return undefined;
  }
}

const fonts = {
  bold: fontFile('Inter Display:bold') ?? fontFile('sans:bold'),
  regular: fontFile('Inter:medium') ?? fontFile('sans'),
};

let textSeq = 0;
function text(
  dir: string,
  value: string,
  opts: { size: number; x: string; y: string; color?: string; bold?: boolean; shadow?: boolean },
): string {
  const font = opts.bold === false ? fonts.regular : fonts.bold;
  if (!font) return '';
  // A text file avoids escaping text inside the filter graph.
  const file = join(dir, `text-${++textSeq}.txt`);
  writeFileSync(file, value);
  const shadow = opts.shadow ? ':shadowcolor=black@0.45:shadowx=3:shadowy=3' : '';
  return `,drawtext=fontfile=${font}:textfile=${file}:fontsize=${opts.size}:fontcolor=${opts.color ?? 'white'}:x=${opts.x}:y=${opts.y}${shadow}`;
}

/** Stacked big lines in the lower left corner, plus an optional small label. */
function caption(dir: string, c: Cover, color = 'white', size = 92): string {
  const step = Math.round(size * 0.95);
  let out = c.lines
    .map((line, i) =>
      text(dir, line, {
        size,
        x: '44',
        y: `h-${70 + step * (c.lines.length - i)}`,
        color,
        shadow: color === 'white',
      }),
    )
    .join('');
  if (c.small) out += text(dir, c.small, { size: 26, x: '48', y: '46', color: `${color}@0.85`, bold: false });
  return out;
}

function coverFilter(dir: string, c: Cover): { input: string; filter: string } {
  const [c0 = '#000000', c1 = '#ffffff', c2 = c1, c3 = c2] = c.colors;
  const size = 's=600x600';
  switch (c.style) {
    case 'gradient':
    case 'radial':
      return {
        input: `gradients=${size}:c0=${c0.replace('#', '0x')}:c1=${c1.replace('#', '0x')}:c2=${c2.replace('#', '0x')}:x0=0:y0=0:x1=600:y1=600:nb_colors=3:type=${c.style === 'radial' ? 'radial' : 'linear'}:seed=7`,
        filter: `noise=alls=7:allf=t,vignette=PI/5${caption(dir, c)}`,
      };
    case 'rings':
      return {
        input: `color=c=black:${size}`,
        filter: `${mix(c0, c1, 'pow(0.5+0.5*sin(hypot(X-430,Y-170)/13),6)')},gblur=sigma=1.2${caption(dir, c, 'white', 78)}`,
      };
    case 'duotone':
      return {
        input: `color=c=black:${size}`,
        filter: `${mix(c0, c1, '0.5+0.5*sin(X/57+sin(Y/83)*2.2)*cos(Y/71-X/190)')},gblur=sigma=10,noise=alls=6:allf=t${text(dir, c.lines.join('\n'), { size: 104, x: '(w-tw)/2', y: '(h-th)/2', shadow: true })}${c.small ? text(dir, c.small, { size: 26, x: '(w-tw)/2', y: 'h-70', bold: false, color: 'white@0.85' }) : ''}`,
      };
    case 'poster': {
      const [accent, ink, paper] = [c0, c1, c2];
      return {
        input: `color=c=black:${size}`,
        filter: `${mix(ink, accent, 'lt(mod(X+Y,90),45)')},drawbox=x=60:y=60:w=480:h=480:color=${paper.replace('#', '0x')}@1:t=fill${text(dir, c.lines[0] ?? '', { size: 128, x: '92', y: '120', color: ink.replace('#', '0x') })}${text(dir, c.lines[1] ?? '', { size: 128, x: '92', y: '270', color: accent.replace('#', '0x') })}${c.small ? text(dir, c.small, { size: 30, x: '94', y: '470', color: ink.replace('#', '0x'), bold: false }) : ''}`,
      };
    }
    case 'halftone':
      return {
        input: `color=c=black:${size}`,
        filter: `${mix(c0, c1, 'lt(hypot(mod(X,36)-18,mod(Y,36)-18),3+13*Y/H)')}${caption(dir, c, dark(c0) ? 'white' : '0x1d1d1d', 88)}`,
      };
    case 'sun': {
      // Synthwave sun: a striped disc over a vertical gradient.
      const inSun = '255*lt(hypot(X-300,Y-260),175)*(lt(Y,250)+gt(mod(Y,28),9+Y/40))';
      return {
        input: `color=c=black:${size}`,
        filter: `${mix(c0, c1, 'Y/H')}[bg];color=c=black:${size},${mix(c2, c3, '(Y-85)/350')}[sun];color=c=black:${size},geq=r='${inSun}':g='${inSun}':b='${inSun}'[mask];[bg][sun][mask]maskedmerge${text(dir, c.lines.join(' '), { size: 66, x: '(w-tw)/2', y: 'h-110', shadow: true })}`,
      };
    }
    case 'letter':
      return {
        input: `color=c=${c0.replace('#', '0x')}:${size}`,
        filter: `noise=alls=5:allf=t${text(dir, c.lines[0] ?? '', { size: 620, x: '230', y: '-40', color: c1.replace('#', '0x') })}${c.small ? text(dir, c.small, { size: 26, x: '46', y: 'h-70', color: c1.replace('#', '0x'), bold: false }) : ''}`,
      };
  }
}

function makeCover(dir: string, c: Cover, out: string): void {
  const { input, filter } = coverFilter(dir, c);
  const complex = filter.includes('[bg]');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    input,
    ...(complex ? ['-filter_complex', `[0:v]${filter}`] : ['-vf', filter]),
    '-frames:v',
    '1',
    '-q:v',
    '3',
    out,
  ]);
}

function buildLibrary(lang: Lang, music: string): void {
  const names = folderNames[lang];
  const tmp = join(work, 'covers');
  mkdirSync(tmp, { recursive: true });
  const paths: Record<string, string> = {};
  const counters: Record<string, number> = {};
  tracks.forEach((t, i) => {
    const folder = t.folder ? names[t.folder]! : '';
    const no = (counters[folder] = (counters[folder] ?? 0) + 1);
    const file = `${folder ? String(no).padStart(2, '0') + ' - ' : ''}${t.artist} - ${t.title}.mp3`;
    const rel = folder ? `${folder}/${file}` : file;
    const out = join(music, rel);
    mkdirSync(dirname(out), { recursive: true });
    const cover = join(tmp, `cover-${i}.jpg`);
    if (!existsSync(cover)) makeCover(tmp, t.cover, cover);
    execFileSync('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${196 + i * 11}:duration=${t.seconds}:sample_rate=22050`,
      '-i',
      cover,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-c:v',
      'mjpeg',
      '-disposition:v',
      'attached_pic',
      '-id3v2_version',
      '3',
      '-metadata',
      `title=${t.title}`,
      '-metadata',
      `artist=${t.artist}`,
      '-metadata',
      `album=${t.album}`,
      '-metadata',
      `track=${no}`,
      out,
    ]);
    paths[t.title] = rel;
  });
  const m3u = ['#EXTM3U', ...legDay.map((title) => paths[title]!)].join('\n') + '\n';
  writeFileSync(join(music, `${names.legDay}.m3u`), m3u);
}

// ---- server ----------------------------------------------------------------

async function startServer(lang: Lang) {
  const root = join(work, lang);
  rmSync(root, { recursive: true, force: true });
  const music = join(root, 'music');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  console.info(`[${lang}] generating the demo library…`);
  buildLibrary(lang, music);
  const bin = join(work, 'syncmusic');
  if (!existsSync(bin)) {
    console.info('building the server…');
    execFileSync('go', ['build', '-o', bin, './cmd/syncmusic'], { cwd: repo, stdio: 'inherit' });
  }
  const child = spawn(bin, [], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      SYNCMUSIC_MUSIC_DIR: music,
      SYNCMUSIC_DATA_DIR: data,
      SYNCMUSIC_LISTEN: `127.0.0.1:${port}`,
      SYNCMUSIC_PASSWORD: PASSWORD,
      SYNCMUSIC_SCAN_INTERVAL: '0',
      SYNCMUSIC_LOG_LEVEL: 'warn',
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('server did not start');
}

// ---- phones ----------------------------------------------------------------

interface Phone {
  ctx: BrowserContext;
  page: Page;
}

async function phone(browser: Browser, lang: Lang): Promise<Phone> {
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    deviceScaleFactor: 2,
    locale: lang === 'pl' ? 'pl-PL' : 'en-US',
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  await page.goto(base);
  return { ctx, page };
}

async function joinRoom(p: Phone, T: Messages, name: string, room: string): Promise<void> {
  const { page } = p;
  await page.getByLabel(T.yourName).fill(name);
  await page.getByLabel(T.room).fill(room);
  await page.getByLabel(T.password).fill(PASSWORD);
  await page.getByRole('button', { name: T.join }).click();
  await page.locator('.tile').nth(3).waitFor({ timeout: 60_000 });
}

function debug(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { __syncmusic: () => { playing: boolean; paused: boolean; elementMs: number } }
    ).__syncmusic(),
  );
}

async function waitPlaying(page: Page): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const d = await debug(page);
    if (d.playing && !d.paused && d.elementMs > 0) return;
    await page.waitForTimeout(200);
  }
  throw new Error('playback did not start');
}

async function nav(page: Page, label: string): Promise<void> {
  await page.locator('.bottom-nav').getByRole('button', { name: label }).click();
}

async function queueFromSearch(page: Page, T: Messages, query: string, title: string, label: string) {
  await nav(page, T.tabSearch);
  const box = page.getByPlaceholder(T.searchPlaceholder);
  await box.fill(query);
  await page.locator('.track-row', { hasText: title }).getByRole('button', { name: '⋯' }).click();
  await page.getByRole('button', { name: label }).click();
  await box.fill('');
}

// ---- capture ---------------------------------------------------------------

async function shoot(page: Page, out: string, name: string): Promise<string> {
  await page.waitForTimeout(400); // let transitions and images settle
  const file = join(out, `${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.info(`  ${name}.jpg`);
  return file;
}

async function capture(lang: Lang, browser: Browser): Promise<void> {
  const T: Messages = lang === 'pl' ? pl : en;
  const names = folderNames[lang];
  const [me, friend1, friend2] = people[lang];
  const out = resolve(repo, 'docs/images', lang);
  mkdirSync(out, { recursive: true });

  const server = await startServer(lang);
  try {
    const login = await phone(browser, lang);
    await login.page.getByLabel(T.yourName).fill(me);
    await login.page.getByLabel(T.room).fill(names.gym!);
    await login.page.getByLabel(T.password).fill('gym-password');
    await shoot(login.page, out, 'login');
    await login.ctx.close();

    const a = await phone(browser, lang);
    const b = await phone(browser, lang);
    const c = await phone(browser, lang);
    await joinRoom(a, T, me, names.gym!);
    await joinRoom(b, T, friend1, names.gym!);
    await joinRoom(c, T, friend2, names.gym!);

    // Start the gym folder from its second track and skip into it.
    await a.page.locator('.tile', { hasText: names.gym! }).click();
    await a.page.locator('.track-row', { hasText: 'Golden Hour' }).locator('.track-main').click();
    await waitPlaying(a.page);
    await a.page.locator('.mini-row').click();
    const slider = a.page.getByRole('slider');
    for (let i = 0; i < 8; i++) {
      await slider.press('ArrowRight');
      await a.page.waitForTimeout(150);
    }
    await a.page.locator('.np-header').getByRole('button', { name: 'close' }).click();

    // Friends queue a couple of songs.
    await queueFromSearch(b.page, T, 'afterglow', 'Afterglow', T.playNext);
    await queueFromSearch(c.page, T, 'highway', 'Highway 9', T.addToQueue);

    // Keep the gym folder on the phone.
    const download = a.page.getByRole('button', { name: T.download, exact: true });
    await download.click();
    await a.page.getByRole('button', { name: T.downloaded, exact: true }).waitFor({ timeout: 120_000 });
    await waitPlaying(a.page);
    await a.page.waitForTimeout(2500); // drift settles, presence refreshes

    await shoot(a.page, out, 'folder');
    await nav(a.page, T.tabLibrary);
    await shoot(a.page, out, 'library');
    await a.page.locator('.mini-row').click();
    await a.page.getByRole('dialog', { name: T.nowPlaying }).waitFor();
    await a.page.waitForTimeout(1200);
    await shoot(a.page, out, 'now-playing');
    await a.page.locator('.np-header').getByRole('button', { name: T.tabQueue }).click();
    await a.page.locator('.queue').waitFor();
    await shoot(a.page, out, 'queue');

    await nav(a.page, T.tabSearch);
    await a.page.getByPlaceholder(T.searchPlaceholder).fill('night');
    await a.page.locator('.track-row').first().waitFor();
    await a.page.locator('input[type=search]').blur();
    await shoot(a.page, out, 'search');
    await a.page.locator('.track-row', { hasText: 'Night Bloom' }).getByRole('button', { name: '⋯' }).click();
    await shoot(a.page, out, 'track-menu');
    await a.page.keyboard.press('Escape');

    await nav(a.page, T.tabSettings);
    await shoot(a.page, out, 'settings');

    // Offline: downloaded tracks keep playing, the rest is marked.
    await nav(a.page, T.tabLibrary);
    await a.page.locator('.list-item', { hasText: names.legDay! }).click();
    await a.page.waitForTimeout(1500); // covers load before the network goes away
    await a.ctx.setOffline(true);
    await a.page.locator('.badge-offline').waitFor({ timeout: 30_000 });
    await a.page.waitForTimeout(800);
    await shoot(a.page, out, 'offline');
    await a.ctx.setOffline(false);

    for (const p of [a, b, c]) await p.ctx.close();
  } finally {
    server.kill();
  }
}

const bannerText: Record<Lang, { tagline: string; facts: string }> = {
  en: {
    tagline: "Listen together, perfectly in sync.<br>Your music on every friend's phone.",
    facts: 'Self-hosted · offline-first · one small container',
  },
  pl: {
    tagline: 'Słuchajcie razem, idealnie równo.<br>Twoja muzyka na telefonach znajomych.',
    facts: 'Self-hosted · działa offline · jeden mały kontener',
  },
};

/** 1280×640 banner on top of the README, also used for link previews. */
async function banner(browser: Browser, lang: Lang): Promise<void> {
  const dir = resolve(repo, 'docs/images', lang);
  const img = (f: string) => `data:image/jpeg;base64,${readFileSync(join(dir, f)).toString('base64')}`;
  const icon = `data:image/png;base64,${readFileSync(resolve(repo, 'web/public/icon-512.png')).toString('base64')}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const phone = (f: string, x: number, y: number, rotate: number) =>
    `<div style="position:absolute;left:${x}px;top:${y}px;width:250px;height:537px;border-radius:34px;padding:8px;
      background:#1c2433;box-shadow:0 24px 60px rgba(0,0,0,.6),inset 0 0 0 2px #2c3647;transform:rotate(${rotate}deg)">
      <img src="${img(f)}" style="width:100%;height:100%;object-fit:cover;object-position:top;border-radius:27px;display:block"></div>`;
  await page.setContent(`<!doctype html><html><body style="margin:0;font-family:Inter,system-ui,sans-serif">
    <div style="position:relative;width:1280px;height:640px;overflow:hidden;color:#fff;
      background:radial-gradient(900px 600px at 15% 10%,#17324a 0%,#0b1120 60%,#070b14 100%)">
      <div style="position:absolute;left:72px;top:150px;width:565px">
        <img src="${icon}" width="96" height="96" style="border-radius:22px;display:block">
        <div style="font-size:76px;font-weight:800;letter-spacing:-1.5px;margin-top:26px">SyncMusic</div>
        <div style="font-size:28px;line-height:1.35;color:#cbd5e1;margin-top:12px">${bannerText[lang].tagline}</div>
        <div style="font-size:21px;color:#34d399;margin-top:26px">${bannerText[lang].facts}</div>
      </div>
      ${phone('library.jpg', 650, 120, -6)}${phone('queue.jpg', 1000, 110, 6)}${phone('now-playing.jpg', 820, 60, 0)}
    </div></body></html>`);
  await page.screenshot({ path: join(dir, 'banner.jpg'), type: 'jpeg', quality: 88 });
  console.info(`  ${lang}/banner.jpg`);
  await ctx.close();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asked = args.filter((a): a is Lang => a === 'en' || a === 'pl');
  const langs: Lang[] = asked.length > 0 ? asked : ['en', 'pl'];
  const onlyBanners = args.includes('banner');
  if (!onlyBanners && !existsSync(join(repo, 'internal/webui/dist/index.html'))) {
    throw new Error('build the web client first: npm run build');
  }
  rmSync(join(work, 'syncmusic'), { force: true });
  const browser = await chromium.launch({
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    for (const lang of langs) {
      if (!onlyBanners) await capture(lang, browser);
      await banner(browser, lang);
    }
  } finally {
    await browser.close();
  }
}

await main();
