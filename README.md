# 🎵 SyncMusic

> **Listen together. Perfectly in sync.**

🤖 *Concept and execution designed by a human, coded 100% by AI.*

SyncMusic is a self-hosted, low-latency music synchronization server. Every connected client plays the same song at the same position — simultaneously. Built on cutting-edge web protocols: **HTTP/3**, **WebTransport**, and **QUIC**.

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
| **Distributed Locking** | Redlock (go-redsync) ensures atomic state across multiple backend instances |
| **Observability** | Integrated Prometheus & Grafana metrics for real-time traffic and performance monitoring |
| **Security** | Full JWT signature verification (HMAC-SHA256) and isolated DB environments |
| **Clock Precision** | Background NTP re-calibration (6h loop) to prevent server-side clock drift |
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
│  • Redis Redlock  │
│                   │  ←→ [Redis 8 / PubSub Cluster]
│  • Postgres (DB)  │  ←→ [PostgreSQL 17 (Isolated)]
└───────────────────┘
          │
┌─────────▼──────────────────────┐
│   Observability Layer          │
│   • Prometheus (:9090)         │
│   • Grafana (:3000)            │
└────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- A folder of music files on the host machine
- (Optional) [Tailscale](https://tailscale.com/) for remote access

### 2. Clone the repository

```bash
# Clone the repository
git clone https://github.com/RafalPolawski/SyncMusic.git
cd SyncMusic

# Set your music path
echo "MUSIC_DIR=/path/to/your/music" > .env
```

### 3. Start the stack

Choose your preferred distribution channel:

*   **Stable Version (Recommended)**: Pulls the latest verified release from GHCR. This is the fastest and most reliable way to run the app.
    ```bash
    docker compose pull
    docker compose up -d
    ```

*   **Development Build**: Builds the application from your local source code. Use this if you want to test the latest (potentially unstable) changes before a formal release.
    ```bash
    docker compose up -d --build
    ```

### 4. Keycloak Setup (Identity & Persistence)

SyncMusic uses Keycloak to manage users and sessions. To get started:

1.  Access the Keycloak Admin Console at `http://localhost:8080/admin` (or via Caddy at your domain).
2.  Log in using the credentials set in your `.env` file (Default: `admin` / `admin`).
3.  **Create a Realm**:
    -   Click the **Master** dropdown in the top-left → **Create Realm**.
    -   Name it `syncmusic`.
4.  **Create a Client**:
    -   Go to **Clients** → **Create client**.
    -   Client ID: `syncmusic-frontend`.
    -   Valid Redirect URIs: `http://localhost/*` and `https://*`.
    -   Web Origins: `*` (or your domain).
5.  **Create a User**:
    -   Go to **Users** → **Add user**.
    -   Set a username, save, and go to the **Credentials** tab to set a password (toggle off "Temporary").

### 5. Access the app

| Method | URL | Notes |
|---|---|---|
| **Local (HTTP)** | `http://localhost` | Standard access |
| **LAN (HTTPS)** | `https://<your-ip>` | Accept the self-signed cert warning |

---

## 🛠️ Tech Stack

| Component | Technology |
|---|---|
| **Backend** | Go 1.24, `quic-go`, `webtransport-go`, `go-redis` |
| **Database** | PostgreSQL 18, Keycloak DB |
| **Cache/Sync**| Redis 8 (Pub/Sub & Redlock) |
| **Frontend** | Vanilla JS, Vite 5 (Build tool), Nginx (Production server) |
| **Proxy** | Caddy 2 (HTTP/3, Automatic TLS) |

---

## 📁 Repository Structure

- `backend/`: Go source code and Dockerfile.
- `frontend/`: JS/CSS source code and Nginx-based Dockerfile.
- `monitoring/`: Prometheus and Grafana configurations.
- `infrastructure/`: Database initialization scripts.
- `Caddyfile`: Reverse proxy and TLS configuration.
- `docker-compose.yml`: Production-ready stack definition.

---

## 📄 License

[GNU General Public License v3.0](LICENSE)
