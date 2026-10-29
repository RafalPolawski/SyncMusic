// Starts a SyncMusic server for the end-to-end tests with a freshly
// generated music library (sine tones made with ffmpeg).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../test-results/e2e-server');
const music = join(root, 'music');
const data = join(root, 'data');
const port = process.env.E2E_PORT ?? '18080';

const tracks = [
  ['Siłownia/01 - Rozgrzewka.mp3', 12, 330],
  ['Siłownia/02 - Przysiady.flac', 12, 440],
  ['Siłownia/03 - Martwy Ciąg.mp3', 12, 550],
  ['Krótkie/Raz.mp3', 5, 660],
  ['Krótkie/Dwa.mp3', 5, 770],
  ['Krótkie/Trzy.mp3', 5, 880],
  ['Luźny.mp3', 8, 990],
];

rmSync(root, { recursive: true, force: true });
for (const [rel, seconds, freq] of tracks) {
  const out = join(music, rel);
  mkdirSync(dirname(out), { recursive: true });
  const title = rel
    .split('/')
    .pop()
    .replace(/\.\w+$/, '')
    .replace(/^\d+ - /, '');
  const codec = rel.endsWith('.flac') ? ['-c:a', 'flac'] : ['-c:a', 'libmp3lame', '-b:a', '128k'];
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${seconds}`,
    '-ac',
    '2',
    '-metadata',
    `title=${title}`,
    '-metadata',
    'artist=E2E',
    ...codec,
    out,
  ]);
}
mkdirSync(data, { recursive: true });

let bin = process.env.SYNCMUSIC_BIN;
if (!bin) {
  bin = join(root, process.platform === 'win32' ? 'syncmusic.exe' : 'syncmusic');
  execFileSync('go', ['build', '-o', bin, './cmd/syncmusic'], {
    cwd: resolve(here, '../..'),
    stdio: 'inherit',
  });
}
if (!existsSync(bin)) throw new Error(`server binary not found: ${bin}`);

const child = spawn(bin, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SYNCMUSIC_MUSIC_DIR: music,
    SYNCMUSIC_DATA_DIR: data,
    SYNCMUSIC_LISTEN: `127.0.0.1:${port}`,
    SYNCMUSIC_PASSWORD: 'e2e-secret',
    SYNCMUSIC_START_DELAY: '1200ms',
    SYNCMUSIC_SCAN_INTERVAL: '0',
    SYNCMUSIC_LOG_LEVEL: 'info',
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
