# Room protocol

Clients talk to the server over a WebSocket at `/api/ws` (authenticated with the session cookie). Every message is one JSON object with a `type`. The protocol version is `1` (`internal/protocol.Version`). Types are defined in `internal/protocol` (Go) and `web/src/sync/protocol.ts` (TypeScript).

## Connection lifecycle

1. The client connects and sends `hello`.
2. The server answers `welcome`, then a full `state` (including `queue` and `context`) and `presence`.
3. From then on the client sends `ping`, `cmd`, `status` and `profile` messages. The server pushes `state`, `presence`, `ack`, `pong`, `library` and `error`.

If the client's protocol version differs, the server sends `error` with `protocol_mismatch` and closes the connection, and the app offers to reload. A second connection with the same `clientId` replaces the first one, which receives `error` with `replaced`.

## Client → server

### `hello`

```json
{ "type": "hello", "protocol": 1, "clientId": "b4c1…", "name": "Ala", "room": "Gym", "format": "opus", "quality": "medium" }
```

`clientId` is a stable per-device id (8–64 characters `[A-Za-z0-9_-]`). Room names are case-insensitive, up to 32 letters, digits, spaces, `-` and `_`.

### `ping`

```json
{ "type": "ping", "id": 17, "t0": 1761170000123.4 }
```

### `cmd`

```json
{ "type": "cmd", "id": "c5-1x2y", "cmd": { "op": "seek", "positionMs": 61000 } }
```

| `op` | Fields | Effect |
|---|---|---|
| `play` | `positionMs?` | Resume (after `ResumeDelay`), or start the context/queue. |
| `pause` | `positionMs?` | Pause. A position within 3 s of the server's estimate is used as given. |
| `seek` | `positionMs` | Jump within the current track. |
| `next`, `prev` | | Skip. `prev` restarts the track after 3 s of playback. |
| `playContext` | `context {kind,id,name,tracks}`, `startIndex?` | Play a folder, playlist, search result or the library. |
| `jump` | `index` | Play the context entry at this position of the play order. |
| `playEntry` | `entryId` | Play a queued entry now. |
| `queueAdd` | `trackIds`, `next?` | Append, or insert at the front with `next`. |
| `queueRemove` | `entryId` | |
| `queueMove` | `entryId`, `toIndex` | |
| `queueClear` | | |
| `shuffle` | `on` | Reshuffles the context order, keeping the current track first. |
| `repeat` | `mode` (`off`, `all`, `one`) | |
| `waitForAll` | `on` | Toggle the start barrier. |
| `ended` | `trackId`, `entryId?` | Fallback auto-advance for tracks of unknown length. |

### `status`

Sent every few seconds and whenever it changes. It is used for presence and the start barrier.

```json
{ "type": "status", "trackId": "a1b2…", "ready": true, "buffering": false, "playing": true, "driftMs": -4, "rttMs": 38, "offline": 120 }
```

### `profile`

```json
{ "type": "profile", "name": "Ala", "quality": "low" }
```

## Server → client

### `welcome`

```json
{ "type": "welcome", "protocol": 1, "serverTime": 1761170000150.2, "room": { "id": "gym", "name": "Gym" },
  "clientId": "b4c1…", "libraryVersion": "9f3a…", "timing": { "startDelayMs": 1500, "resumeDelayMs": 400 }, "serverVersion": "v1.0.0" }
```

### `pong`

```json
{ "type": "pong", "id": 17, "t0": 1761170000123.4, "t1": 1761170000140.9, "t2": 1761170000141.0 }
```

`t1` is when the ping arrived and `t2` when the pong was written (server clock, fractional ms).

### `ack`

```json
{ "type": "ack", "id": "c5-1x2y", "ok": false, "version": 42, "error": { "code": "unknown_track", "message": "…" } }
```

A repeated command id gets the original acknowledgement and is not applied twice. Error codes: `bad_request`, `unknown_op`, `unknown_track`, `not_found`, `nothing_to_play`, `queue_full`, `too_large`.

### `state`

```json
{
  "type": "state", "version": 42, "serverTime": 1761170001000,
  "playback": { "trackId": "a1b2…", "positionMs": 0, "anchorMs": 1761170002500, "playing": true, "durationMs": 201000 },
  "contextIndex": 3, "shuffle": false, "repeat": "off", "waitForAll": true,
  "hold": { "trackId": "a1b2…", "startedMs": 1761170001000, "untilMs": 1761170011000 },
  "queueVersion": 7, "queue": [ { "id": "q1f", "trackId": "c3d4…", "addedBy": "Bartek" } ],
  "contextVersion": 2, "context": { "kind": "folder", "id": "Gym", "name": "Gym", "tracks": ["…"], "order": [0, 1, 2] }
}
```

`queue` and `context` are only included when their version changed since the last state this connection received (and always in the first one). Within one connection versions only grow. The first state after a reconnect is always accepted. See [architecture.md](architecture.md#the-room-timeline) for how to interpret `playback`.

### `presence`

```json
{ "type": "presence", "members": [ { "clientId": "…", "name": "Ala", "connected": true, "trackId": "…", "ready": true,
  "buffering": false, "playing": true, "driftMs": -4, "rttMs": 38, "offline": 120, "lastSeen": 1761170001000 } ],
  "waiting": ["Bartek"] }
```

Disconnected members stay listed (with `connected: false`) for two minutes.

### `library`

```json
{ "type": "library", "version": "a7c9…" }
```

The library changed and the client should refetch `/api/library`.

### `error`

```json
{ "type": "error", "code": "replaced", "message": "connected from another tab" }
```

## REST API

| Method and path | Description |
|---|---|
| `GET /api/session` | `{authRequired, authenticated, serverVersion, transcoding}` |
| `POST /api/auth/login` | `{password}` → sets the session cookie (204), 401 or 429 |
| `POST /api/auth/logout` | Clears the cookie |
| `GET /api/library` | Tracks, folders and playlists (ETag, gzip) |
| `GET /api/library/status` | Scanner status |
| `POST /api/library/rescan` | Start an incremental scan |
| `GET /api/tracks/{id}/audio?f=opus\|aac&q=low\|medium\|high\|original&v=rev` | Audio, range requests supported. With `v` the response is cached forever. |
| `GET /api/tracks/{id}/cover?s=128\|512&v=rev` | JPEG cover (embedded art or folder image) |
| `GET /api/rooms` | Rooms with their listeners |
| `GET /api/ws` | WebSocket |
| `GET /healthz`, `GET /readyz`, `GET /metrics` | Operations |
