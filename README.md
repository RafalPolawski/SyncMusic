# 🎵 SyncMusic

> **Listen together. Perfectly in sync.**

🤖 *Concept and execution designed by a human, coded 100% by AI.*

SyncMusic is a self-hosted, low-latency music synchronization server. Every connected client plays the same song at the same position — simultaneously. Built on cutting-edge web protocols: **HTTP/3**, **WebTransport**, and **QUIC**.

---

## ✨ Features

### ✅ Implemented

| Feature | Description |
|---|---|
| **WebTransport over HTTP/3 (QUIC)** | Real-time bidirectional communication over UDP — lower latency than WebSocket/TCP |
| **Global playback state** | Play, pause, seek, and track changes are broadcast to all connected clients instantly |
| **New client sync** | Clients joining mid-session receive the current song, position, shuffle & repeat state immediately |
| **Shuffle & Repeat modes** | Three repeat modes (off / playlist / track) and shuffle — state shared across all clients |
| **Music library scan** | Backend walks the mounted music directory and reads tags (title, artist) from supported audio files concurrently |
| **Broad audio support** | Supports `.opus`, `.mp3`, `.flac`, `.wav`, `.ogg`, `.m4a`, and `.aac` files natively |
| **Library caching** | Library is scanned once and served from RAM on subsequent requests |
| **Embedded album art** | `/api/cover` extracts and serves embedded artwork from audio file tags |
| **Folder-based browsing** | Frontend groups tracks by folder; active folder is highlighted globally |
| **Self-signed TLS for WebTransport** | Backend auto-generates a short-lived ECDSA certificate; hash exposed via `/api/cert-hash` for browser trust |
| **Reverse proxy (Caddy)** | HTTP/1.1 + HTTPS (LAN) routing via Caddy, including Caddy's internal CA for self-signed certs |
| **Tailscale / MagicDNS access** | Accessible via `tailscale serve` — uses `http://:80` block proxied by Tailscale for HTTPS |
| **Dockerized deployment** | Three-service `docker-compose.yml`: `sync-app` (Go), `sync-frontend` (Vite), `caddy` |
| **Vite frontend build** | Modular ES module frontend with `api.js`, `player.js`, `webtransport.js`, `main.js` |
| **Service Worker (PWA)** | Offline functionality via `sw.js` — caches static assets |
| **Mobile-friendly UI** | Responsive layout, pull-to-dismiss gesture, History API integration, and native media controls (`MediaSession` API) |
| **Scan progress UI** | Real-time loading screen tracking the backend's initialization and library scan progress |
| **Global Queue Management** | Add-to-queue and remove functionality with synchronized state superseding default folder playlists |

---

### 🚧 Planned / In Progress

| Feature | Status | Notes |
|---|---|---|
| **NTP-style precision sync** | 📋 Planned | Client measures RTT on connect, calculates clock offset; server sends scheduled `PLAY_AT` timestamp instead of immediate command |
| **PWA full install support** | 📋 Planned | `manifest.json`, app icons, `display: standalone` for home-screen install on Android/iOS |
| **User identity / nicknames** | 📋 Planned | Each client announces a display name; server shows who is currently controlling playback |
| **Lyrics display** | 📋 Planned | Fetch synchronized lyrics (e.g. LRCLIB API) and display them in sync with playback position |
| **Persistent state (Redis)** | 📋 Planned | Replace in-memory globals with Redis for crash recovery and multi-instance support |
| **User accounts (PostgreSQL)** | 📋 Planned | Playlists, listening history, per-user settings |
| **MinIO / S3 file storage** | 📋 Planned | Move music files out of bind-mount into S3-compatible object storage for scalability |
| **Multiple rooms** | 📋 Planned | Support isolated "rooms" — each room has its own playback state |
| **Volume sync** | 📋 Planned | Optional global volume level shared across clients |
| **Android / iOS native client** | 💡 Idea | Native app using `WebTransport` or fallback WebSocket for background audio playback |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        Clients                           │
│        Browser / PWA   ←→   WebTransport (QUIC/UDP)      │
└───────────────────┬──────────────────────────────────────┘
                    │ HTTPS (443) / HTTP (80)
┌───────────────────▼──────────────────────────────────────┐
│                   Caddy Reverse Proxy                    │
│   • HTTP/3 (QUIC) termination                            │
│   • Internal CA (local_certs) for LAN HTTPS              │
│   • Tailscale serve proxy for MagicDNS HTTPS             │
└────────┬─────────────────────────┬───────────────────────┘
         │ /api/* /music/*         │ /*
┌────────▼────────┐      ┌─────────▼────────┐
│   Go Backend    │      │  Vite Frontend   │
│   :12137 (TCP)  │      │  :5173 (TCP)     │
│   :4433 (UDP)   │      │                  │
│                 │      │  • api.js        │
│  • REST API     │      │  • player.js     │
│  • Music serve  │      │  • webtrans.js   │
│  • WebTransport │      │  • main.js       │
│  • Library scan │      │  • sw.js (PWA)   │
└─────────────────┘      └──────────────────┘
```

### Communication Protocol

All playback control flows through a single **WebTransport stream** over UDP port `4433`.

Messages are newline-delimited JSON:

| Direction | Action | Payload |
|---|---|---|
| Client → Server | `load` | `{ song, folder }` |
| Client → Server | `play` | `{ time }` |
| Client → Server | `pause` | `{ time }` |
| Client → Server | `seek` | `{ time, isPlaying }` |
| Client → Server | `shuffle` | `{ state: bool }` |
| Client → Server | `repeat` | `{ state: 0\|1\|2 }` |
| Client → Server | `enqueue` | `{ item: {path, title, artist} }` |
| Client → Server | `dequeue` | `{ id: float64 }` |
| Server → Client | `sync` | `{ song, time, isPlaying, isShuffle, isRepeat, folder, queue }` *(on connect)* |
| Server → All | `queue_update` | `{ queue: [...] }` |
| Server → All | *(echo)* | All playback actions are broadcast verbatim to every connected client |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Go 1.22+, `quic-go`, `webtransport-go`, `dhowden/tag` |
| **Frontend** | Vanilla JS (ES modules), Vite, Web Audio API |
| **Transport** | WebTransport over HTTP/3 (QUIC / UDP) |
| **Reverse Proxy** | Caddy 2 (HTTP/3, internal CA, on-demand TLS) |
| **Containerization** | Docker, Docker Compose |
| **Networking** | Tailscale + MagicDNS for zero-config remote access |
| **PWA** | Service Worker (`sw.js`) |

---

## 🚀 Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- A folder of `.opus` music files on the host machine
- (Optional) [Tailscale](https://tailscale.com/) for remote access

### 1. Clone the repository

```bash
git clone https://github.com/yourname/SyncMusic.git
cd SyncMusic
```

### 2. Configure the music path

Edit `docker-compose.yml` and update the music volume mount to point to your library:

```yaml
volumes:
  - "/path/to/your/music:/app/music"
```

### 3. Start the stack

```bash
docker compose up --build
```

### 4. Access the app

| Method | URL | Notes |
|---|---|---|
| **Local (HTTP)** | `http://localhost` | No HTTPS needed locally |
| **LAN (HTTPS)** | `https://192.168.x.x` | Accept the self-signed cert warning once |
| **Tailscale** | `https://your-machine.tailnet.ts.net` | Run `tailscale serve --bg https / http://localhost:80` first |

---

## 📡 API Reference

All endpoints are served by the Go backend on `:12137` (proxied via Caddy).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/songs` | Returns JSON array of all scanned tracks `[{ path, title, artist }]` |
| `GET` | `/api/cover?song=<path>` | Returns the embedded album art for the given track |
| `GET` | `/api/cert-hash` | Returns the SHA-256 hash of the WebTransport TLS cert (for browser trust) |
| `GET` | `/api/ok` | Health check endpoint (used by Caddy's on-demand TLS `ask`) |
| `GET` | `/music/<path>` | Streams the audio file directly from the music directory |
| `WS`  | `/wt` (UDP :4433) | WebTransport endpoint for real-time playback sync |

---

## 📁 Project Structure

```
SyncMusic/
├── backend/
│   ├── Dockerfile
│   ├── main.go            # Go server: REST API + WebTransport sync engine
│   └── db.go              # SQLite session parsing and cache layers
├── frontend/
│   ├── Dockerfile
│   ├── index.html
│   ├── vite.config.js
│   ├── sw.js              # Service Worker (PWA / offline cache)
│   └── src/
│       ├── js/
│       │   ├── api.js         # HTTP API helpers
│       │   ├── main.js        # App bootstrap & UI orchestration
│       │   ├── player.js      # Audio playback engine & controls
│       │   └── webtransport.js # WebTransport connection & message handling
│       └── styles/
│           └── main.css
├── caddy/
│   └── Dockerfile
├── Caddyfile              # Caddy reverse proxy config (HTTP/3, TLS, routing)
├── docker-compose.yml
└── LICENSE
```

---

## 🔧 Development

### Running the frontend locally (with hot reload)

```bash
cd frontend
npm install
npm run dev
```

### Running the backend locally

```bash
cd backend
go run main.go
```

> The backend expects a `./music` directory relative to its working directory, or use the Docker volume mount.

---

## 📝 Notes

- **Audio format**: The application fully supports and scans `.opus`, `.mp3`, `.flac`, `.wav`, `.ogg`, `.m4a`, and `.aac` files.
- **WebTransport TLS**: The self-signed certificate regenerates on every container restart. The browser fetches the new hash automatically via `/api/cert-hash`.
- **MagicDNS**: WebTransport connects directly to the host IP (not via MagicDNS hostname) due to browser restrictions on self-signed certificates for arbitrary hostnames.

---

## 📄 License

[GNU General Public License v3.0](LICENSE)
