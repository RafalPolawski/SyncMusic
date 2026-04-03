# 🎵 SyncMusic

> **Listen together. Perfectly in sync.**

🤖 *Concept and execution designed by a human, coded 100% by AI.*

SyncMusic is a self-hosted, low-latency music synchronization server. Every connected client plays the same song at the same position — simultaneously. Built on cutting-edge web protocols: **HTTP/3**, **WebTransport**, and **QUIC**.

[![Build Dev Images](https://github.com/RafalPolawski/SyncMusic/actions/workflows/dev.yml/badge.svg)](https://github.com/RafalPolawski/SyncMusic/actions/workflows/dev.yml)

---

## ✨ Features

| Feature | Description |
|---|---|
| **WebTransport / HTTP/3 (QUIC)** | Real-time bidirectional sync over UDP — lower latency than WebSocket/TCP |
| **Redis Pub/Sub** | Horizontally scalable global state management across multiple server instances |
| **Global playback state** | Play, pause, seek, track change — instantly broadcast to all clients |
| **Advanced Latency Sync** | Ping jitter smoothed client-side with Exponential Moving Average (EMA) and eager-updates |
| **New client sync** | Clients joining mid-session receive current song, position, shuffle & repeat state |
| **Shuffle & Repeat** | Three repeat modes (off / playlist / track) + shuffle — state shared across all clients |
| **Queue management** | Add, remove, reorder (drag-and-drop) — synchronized across all clients |
| **Music library** | Backend walks the mounted music directory and reads ID3/Vorbis tags concurrently |
| **Broad audio support** | `.opus`, `.mp3`, `.flac`, `.wav`, `.ogg`, `.m4a`, `.aac` |
| **SQLite library cache** | Scanned once into SQLite, served instantly on subsequent starts |
| **Embedded album art** | `/api/cover` extracts and serves embedded artwork from audio tags |
| **Folder-based browsing** | Tracks grouped by folder; per-folder offline caching via Service Worker |
| **Offline caching (PWA)** | Cache entire library or per-folder via Service Worker |
| **Mobile mini-player** | Fixed mini-player that morphs into full-screen expanded view |
| **Media Session API** | Lock screen / notification bar controls with artwork on Android & iOS |
| **Settings panel** | Configurable soft-sync threshold, library rescan, cache management |
| **Presence list** | See who else is listening in real time |
| **RTT indicator** | Live round-trip time display with colour-coded quality signal |
| **Self-signed TLS** | Backend auto-generates short-lived ECDSA cert; hash fetched via `/api/cert-hash` |
| **Caddy reverse proxy** | HTTP/3, internal CA, on-demand TLS for LAN HTTPS |
| **Tailscale / MagicDNS** | Zero-config remote access via `tailscale serve` |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Clients                           │
│       Browser / PWA   ←→   WebTransport (QUIC/UDP)      │
└───────────────────┬─────────────────────────────────────┘
                    │ HTTPS (443) / HTTP (80)
┌───────────────────▼─────────────────────────────────────┐
│                  Caddy Reverse Proxy                    │
│   • Internal CA (local_certs) for LAN HTTPS             │
│   • Tailscale serve proxy for MagicDNS HTTPS            │
└────────┬───────────────────────┬────────────────────────┘
         │ /api/*  /music/*      │ /*
┌────────▼──────────┐  ┌─────────▼──────────────────────┐
│   Go Backend      │  │   nginx (static frontend)       │
│   :8080 (TCP)     │  │   :3000 (TCP)                   │
│   :4433 (UDP/WT)  │  │   • Vite-built ES modules       │
│                   │  │   • Service Worker (PWA)         │
│  • REST API       │  │   • player/, library/, queue.js │
│  • WebTransport   │  └────────────────────────────────┘
│  • SQLite (DB)    │
│  • Redis Pub/Sub  │  ←→ [Redis 8 In-Memory State]
└───────────────────┘
```

### WebTransport Message Protocol

All playback control flows through a single **WebTransport stream** on UDP `:4433`.
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
| Client → Server | `queue_move` | `{ from, to }` |
| Server → Client | `sync` | `{ song, time, isPlaying, isShuffle, isRepeat, folder, queue }` *(on connect)* |
| Server → All | `queue_update` | `{ queue: [...] }` |
| Server → All | *(echo)* | All playback actions broadcast to every connected client |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Go 1.24, `quic-go`, `webtransport-go`, `dhowden/tag`, `go-redis` |
| **Database/Cache**| `modernc.org/sqlite` (ID3 tagging), `redis:8-alpine` (Real-time Pub/Sub & State) |
| **Frontend** | Vanilla JS (ES modules), Vite 5, Web Audio API |
| **Transport** | WebTransport over HTTP/3 (QUIC / UDP) |
| **Reverse Proxy** | Caddy 2 (HTTP/3, internal CA, on-demand TLS) |
| **CI/CD** | GitHub Actions → GHCR (`:dev` on push, `:latest` + version on Release) |
| **Containerization** | Docker multi-stage, Docker Compose |
| **Networking** | Tailscale + MagicDNS for zero-config remote access |

---

## 🚀 Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- A folder of music files on the host machine
- (Optional) [Tailscale](https://tailscale.com/) for remote access

### 1. Clone the repository

```bash
git clone https://github.com/RafalPolawski/SyncMusic.git
cd SyncMusic
```

### 2. Set your music path

```bash
echo "MUSIC_DIR=/path/to/your/music" > .env
```

### 3. Start the stack

```bash
docker compose pull   # pulls latest images from GHCR
docker compose up -d
```

### 4. Access the app

| Method | URL | Notes |
|---|---|---|
| **Local (HTTP)** | `http://localhost` | No HTTPS needed locally |
| **LAN (HTTPS)** | `https://192.168.x.x` | Accept the self-signed cert warning once |
| **Tailscale** | `https://your-machine.tailnet.ts.net` | Run `tailscale serve --bg https / http://localhost:80` first |

---

## 🔧 Development

Use `docker-compose.dev.yml` to run with hot reload (Vite HMR):

```bash
docker compose -f docker-compose.dev.yml up --build
```

Frontend source is bind-mounted — changes are reflected instantly without rebuilding.

### Running services individually

```bash
# Frontend (Vite HMR)
cd frontend && npm install && npm run dev

# Backend
cd backend && go run .
```

> The backend expects a `./music` directory relative to its working directory,
> or use the Docker volume mount.

---

## 📁 Project Structure

```
SyncMusic/
├── backend/
│   ├── Dockerfile          # Multi-stage: Go builder → Alpine runtime
│   ├── main.go             # Entry point, HTTP mux, WebTransport init
│   ├── room.go             # Local instance client tracker
│   ├── handlers.go         # REST API endpoints
│   ├── wt.go               # WebTransport session & Redis state logic
│   ├── redis.go            # Redis lock, state structs & PubSub listener
│   ├── tls.go              # Self-signed ECDSA cert generation
│   └── db.go               # SQLite library scan & cache
├── frontend/
│   ├── Dockerfile          # Multi-stage: Node builder → nginx:alpine
│   ├── Dockerfile.dev      # Vite dev server + HMR (dev only)
│   ├── nginx.conf          # SPA fallback, asset caching
│   ├── index.html
│   ├── vite.config.js
│   ├── sw.js               # Service Worker (PWA / offline cache)
│   └── src/
│       ├── js/
│       │   ├── main.js         # App bootstrap & orchestration
│       │   ├── ui.js           # DOM refs & shared utilities
│       │   ├── webtransport.js # WebTransport connection
│       │   ├── cache.js        # Service Worker cache manager
│       │   ├── queue.js        # Queue UI
│       │   ├── api.js          # HTTP API helpers
│       │   ├── player/         # Audio engine (8 focused modules)
│       │   └── library/        # Library browser (3 focused modules)
│       └── styles/
│           ├── main.css        # @import hub
│           ├── base.css        # Variables, reset, layout
│           ├── player.css      # Player & mini-player
│           ├── library.css     # Library, folder list, cache badges
│           ├── queue.css       # Queue & drag-and-drop
│           └── overlay.css     # Join screen & settings modal
├── caddy/
│   └── Dockerfile          # Custom xcaddy build (no Tailscale module)
├── .github/workflows/
│   ├── dev.yml             # Push to main → :dev images on GHCR
│   └── release.yml         # GitHub Release → :latest + :<version> on GHCR
├── Caddyfile               # Production Caddy config
├── Caddyfile.dev           # Dev Caddy config (Vite on :5173)
├── docker-compose.yml      # Production (pulls from GHCR)
└── docker-compose.dev.yml  # Development (builds locally)
```

---

## 📡 API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/songs` | JSON array of all scanned tracks `[{ path, title, artist, size }]` |
| `GET` | `/api/cover?song=<path>` | Embedded album art for the given track |
| `GET` | `/api/cert-hash` | SHA-256 hash of the WebTransport TLS cert |
| `GET` | `/api/scan-status` | Current library scan progress `{ is_scanning, scan_current, scan_total }` |
| `POST` | `/api/rescan` | Trigger a full library rescan |
| `GET` | `/api/ok` | Health check (used by Caddy's on-demand TLS `ask`) |
| `GET` | `/music/<path>` | Streams audio file directly from the music directory |
| `WT` | `/wt` (UDP :4433) | WebTransport endpoint for real-time playback sync |

---

## 📝 Notes

- **WebTransport TLS**: The self-signed certificate regenerates on every container restart. The frontend fetches the new hash automatically via `/api/cert-hash`.
- **MagicDNS**: WebTransport connects directly to the host IP due to browser restrictions on self-signed certs for arbitrary hostnames.
- **Service Worker caching**: Per-folder caching stores tracks individually; a folder can be cached offline even while others stream live.

---

## 📄 License

[GNU General Public License v3.0](LICENSE)
