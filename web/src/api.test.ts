import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, audioUrl, coverUrl, preferredFormat } from './api';
import { mockFetch, sampleLibrary } from './test/harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('returns parsed JSON', async () => {
    mockFetch({
      '/api/session': {
        json: { authRequired: true, authenticated: false, serverVersion: '1', transcoding: true },
      },
    });
    await expect(api.session()).resolves.toMatchObject({ authRequired: true, authenticated: false });
  });

  it('turns error responses into ApiError with the server code', async () => {
    mockFetch({ '/api/auth/login': { status: 401, json: { error: 'unauthorized' } } });
    const err = await api.login('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized', message: 'unauthorized' });
  });

  it('copes with error responses that are not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad gateway', { status: 502 }));
    await expect(api.rooms()).rejects.toMatchObject({ status: 502, code: '', message: 'HTTP 502' });
  });

  it('posts JSON bodies and accepts empty responses', async () => {
    let body: unknown;
    mockFetch({
      '/api/auth/login': (init) => {
        body = JSON.parse(String(init?.body));
        return { status: 204 };
      },
    });
    await expect(api.login('secret')).resolves.toBeUndefined();
    expect(body).toEqual({ password: 'secret' });
  });

  it('fetches the library with an etag', async () => {
    mockFetch({ '/api/library': { json: sampleLibrary, headers: { ETag: '"x"' } } });
    await expect(api.library()).resolves.toMatchObject({ etag: '"x"', data: { version: 'lib-1' } });
    mockFetch({ '/api/library': { status: 304 } });
    await expect(api.library('"x"')).resolves.toBeUndefined();
    mockFetch({ '/api/library': { status: 503, json: {} } });
    await expect(api.library()).rejects.toBeInstanceOf(ApiError);
  });

  it('builds media URLs that change with the file', () => {
    expect(audioUrl({ id: 'a b', rev: 'r1' }, { format: 'opus', quality: 'low' })).toBe(
      '/api/tracks/a%20b/audio?f=opus&q=low&v=r1',
    );
    expect(coverUrl('a', 'r2')).toBe('/api/tracks/a/cover?s=128&v=r2');
    expect(coverUrl('a', 'r2', 512)).toBe('/api/tracks/a/cover?s=512&v=r2');
  });

  it('prefers Opus when the browser can play it', () => {
    const el = (answer: string) => ({ canPlayType: () => answer }) as unknown as HTMLMediaElement;
    expect(preferredFormat(el('probably'))).toBe('opus');
    expect(preferredFormat(el(''))).toBe('aac');
  });
});
