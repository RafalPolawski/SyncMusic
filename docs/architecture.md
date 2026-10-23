# Architecture

SyncMusic is one Go process serving a REST API, a WebSocket endpoint and the embedded web client. State lives in SQLite (library index, room state, settings) and on disk (transcode and cover caches). There are no other services.

```
 phones (PWA)                          server (single binary)
┌──────────────────────┐   HTTPS   ┌──────────────────────────────────────┐
│ UI (React)           │  ───────► │ HTTP API  /api/library, /api/tracks/…│
│ Engine               │           │   auth (password → signed cookie)    │
│  ├ RoomConnection ◄──┼── WS ────►│ Hub ── Room actors (room.Engine)     │
│  ├ ClockSync         │           │ Library scanner ── ffprobe           │
│  ├ timeline (shared) │           │ Transcoder ── ffmpeg (LRU disk cache)│
│  ├ Downloader ───────┼── audio ─►│ Covers (resized, cached)             │
│  └ AudioPlayer       │           │ SQLite                               │
│ IndexedDB · SW cache │           └──────────────────────────────────────┘
└──────────────────────┘
```

## Code map

| Path | Purpose |
|---|---|
| `cmd/syncmusic` | Entry point (`serve`, `healthcheck`, `version`). |
| `internal/app` | Wires everything together, graceful shutdown. |
| `internal/config` | Environment configuration and validation. |
| `internal/store` | SQLite access and embedded migrations. |
| `internal/library` | Scanner, folders/playlists, `.m3u` import, cover art. |
| `internal/media` | ffprobe metadata, ffmpeg transcoding, delivery plan. |
| `internal/room` | The deterministic room state machine and timeline rules. |
| `internal/hub` | WebSocket connections, room actors, presence, persistence. |
| `internal/protocol` | Wire message types. |
| `internal/auth` | Password check, session tokens, login rate limiting. |
| `internal/server` | HTTP routes, security headers, static file serving. |
| `internal/webui` | `go:embed` of the built web client. |
| `web/src/sync` | Client timeline, clock sync, drift control, connection. |
| `web/src/audio` | Audio element driver and Media Session. |
| `web/src/offline` | IndexedDB storage and the download manager. |
| `web/src/engine.ts` | Client orchestration. |
| `web/src/ui` | Views and components. |
| `testdata/sync` | Timeline fixtures shared by the Go and TypeScript tests. |

## The room timeline

A room's playback is stored as

```
playback = { trackId, entryId?, positionMs, anchorMs, playing, durationMs }
```

At server time `t ≥ anchorMs` the position is `positionMs + (t − anchorMs)` while playing. Before `anchorMs` a playing track is *armed*: phones hold it at `positionMs` and start exactly at `anchorMs`. This is how simultaneous starts work: the server picks an anchor a little in the future (`SYNCMUSIC_START_DELAY` for new tracks, `SYNCMUSIC_RESUME_DELAY` for play/seek), long enough for the state to reach every phone.

`room.Normalize` advances the timeline: whenever the current track has ended (`anchorMs + durationMs − positionMs ≤ now`), it is replaced by its successor, anchored at the exact end time of the previous track:

1. the head of the queue, if any;
2. otherwise the next entry of the context's play order (`context.order`, a permutation of `context.tracks`, shuffled by the server when shuffle is on);
3. at the end: wrap around with *repeat all*, restart with *repeat one*, or park paused on the first track.

Because these rules only depend on the state, the durations and the time, the client (`web/src/sync/timeline.ts`) runs exactly the same algorithm. `testdata/sync/timeline.json` pins both implementations. While offline, phones normalise the last known state on their own and therefore keep changing tracks at the same moments as the server and each other.

Commands (`play`, `pause`, `seek`, `next`, `prev`, `playContext`, `jump`, queue operations, `shuffle`, `repeat`, `waitForAll`) are applied by `room.Engine` after normalising to the current time. Every change increments `version`. Queue and context have their own versions so that a frequent `pause` does not resend a 1000-track playlist.

### Wait for everyone

With `waitForAll` enabled, a manual track change also creates a *hold*. Phones report `ready` once they have buffered the track. While somebody is not ready, the room keeps pushing the anchor forward in small steps, up to `SYNCMUSIC_WAIT_FOR_ALL_MAX`, then starts anyway, and late phones catch up by seeking. Automatic advances never hold, because they must stay predictable for offline phones. Upcoming tracks are prefetched, so they are normally ready anyway.

## Clock synchronisation

The client sends pings (`t0`) and the server answers with its receive and send times (`t1`, `t2`). With the arrival time `t3`:

```
rtt    = (t3 − t0) − (t2 − t1)
offset = ((t1 − t0) + (t2 − t3)) / 2
```

Queueing delay on mobile networks only ever makes a round trip longer, so the estimate is the median offset of the five fastest samples out of the last 24. Small changes are slewed and large ones (the phone's clock was corrected) are applied at once. A burst of pings follows every (re)connect and the app returning to the foreground. After that a ping goes out every 3 s, which doubles as a liveness check. The last offset is persisted, so a phone that restarts offline keeps a usable clock.

## Keeping audio aligned

`AudioPlayer` drives one `<audio>` element. Every 200 ms (and on every state change) it computes the target position from the timeline and the synchronised clock:

- **armed start:** park at the start position and call `play()` slightly before the anchor, by the learned play latency;
- **drift under ~30 ms:** do nothing;
- **drift between ~30 and ~700 ms:** change `playbackRate` by up to ±5% (pitch preserved) and absorb the error over roughly three seconds;
- **larger drift** (stall, wake-up): seek, adding the learned seek latency.

The element's position is compared with the target through a median filter. The seek/start latency is learned from the error measured right after each seek and persisted per device. A user setting adds output latency for Bluetooth headphones.

System pauses (incoming call, headphones unplugged) and, by default, headphone/lock-screen buttons pause only the local phone (*personal pause*). The room keeps going, and *Back to the room* resumes in sync.

## Network resilience

- **Coalesced state.** The server keeps only the latest unsent snapshot per connection. A phone on a slow link receives the newest state instead of a backlog. Control messages (pongs, acks) jump the queue.
- **Commands** carry ids. They are acknowledged, retried when unacknowledged, replayed after a reconnect, de-duplicated by the server, and dropped after 8 s because an old "pause" is worse than none.
- **Reconnects** use exponential backoff with jitter, are immediate when the browser reports it is online or the app returns to the foreground, and a watchdog notices silently dead connections after 12 s.
- **Prefetch.** The current and next N tracks of the room are downloaded in full into IndexedDB in the transcoded format and played from local blobs. Downloads retry with backoff, abort when stalled, and stay within an LRU size limit. Folders and playlists can be pinned for offline use.
- **Transcoding** to Opus (or AAC where Opus is unsupported) at 64/96/160 kbit/s makes files 5–10× smaller than FLAC. Small lossy files are passed through untouched. The server prewarms the upcoming tracks of every room in the formats its listeners use.
- **Library** responses carry ETags and are cached on the phone. Media URLs contain a file revision and are immutable.
- **Rooms persist.** Room state is saved to SQLite, so a server restart does not lose the queue.

## Security

- One shared password. A successful login sets an HMAC-signed `HttpOnly`, `SameSite=Lax` cookie (valid for 180 days). Changing the password invalidates all sessions.
- Failed logins are rate limited per client IP, and successful ones never count.
- State-changing endpoints require JSON bodies and a same-origin `Origin`. WebSockets require a same-origin `Origin` as well.
- Paths are cleaned and confined to the music directory. Absolute paths never reach the client.
- Strict security headers (CSP without inline scripts, `frame-ancestors 'none'`, `nosniff`, no referrer).
- The container runs as a non-root user on a distroless base with a read-only music mount.

## Data on disk

```
/data/syncmusic.db          SQLite (library index, rooms, settings)
/data/session.key           random secret for session cookies
/data/cache/transcode/      transcoded audio (LRU, SYNCMUSIC_TRANSCODE_CACHE_SIZE)
/data/cache/covers/         resized cover art
```

Everything except `syncmusic.db` and `session.key` can be deleted at any time.
