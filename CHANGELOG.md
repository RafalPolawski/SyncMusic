# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.1] - 2026-10-29

### Changed

- The project is now licensed under the MIT license (previously GPL-3.0).
- Releases can be started from *Actions → Publish → Run workflow* with a version; the tag is created only after CI, images and binaries succeeded.
- New README and Polish guide with screenshots generated from the real app (`make screenshots`), plus a social preview image for the repository.
- The container image carries its own description and the release version in its metadata, and the multi-arch index is annotated so the package page shows them.

### Fixed

- A phone that ran slightly ahead of the room could stop at the end of a track with "Paused just for you": the browser's late `pause` event from the finished track was taken for a pause by the system.
- `npm ci` on `main` after the tooling update: TypeScript stays on 6.x until typescript-eslint supports 7.

## [1.0.0] - 2026-10-29

A complete rewrite. SyncMusic is now a single self-contained server instead of eight containers.

### Added

- Single Go binary with the web client embedded, SQLite storage and a ~47 MB multi-arch container image (`linux/amd64`, `linux/arm64`) with a minimal static ffmpeg.
- Timeline-based room synchronisation with server-side gapless auto advance, scheduled starts and an optional "wait for everyone" start barrier.
- NTP-style clock sync, playback-rate drift correction and learned per-device play latency.
- Offline playback: upcoming tracks are prefetched, folders and playlists can be saved on the phone, and the timeline (including track changes) continues without a connection.
- Transcoding to Opus or AAC (low/medium/high/original) with an on-disk LRU cache and prewarming of upcoming tracks.
- Library scanner with incremental rescans, folders as playlists, loose tracks, `.m3u` playlists, embedded and folder cover art (resized), and title/artist detection from file names.
- Shared queue (play next, reorder, remove), shuffle, repeat, search, presence with per-listener sync status.
- Personal pause for headphone buttons, lock-screen controls and phone calls. Bluetooth latency compensation.
- Installable PWA in Polish and English with Media Session integration.
- Shared-password login with signed session cookies and rate limiting of failed attempts.
- Health checks, Prometheus metrics, structured logging.
- Unit, integration, fuzz and end-to-end tests. CI, multi-arch image publishing, release binaries and Dependabot.

### Removed

- Redis, PostgreSQL, Keycloak, Caddy, nginx, Prometheus and Grafana containers.
- WebTransport with self-signed certificates (replaced by WebSocket over HTTPS).

## [0.1.0] - 2026-04-09

Initial alpha release (multi-service architecture).

[Unreleased]: https://github.com/RafalPolawski/SyncMusic/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/RafalPolawski/SyncMusic/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/RafalPolawski/SyncMusic/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/RafalPolawski/SyncMusic/releases/tag/v0.1.0
