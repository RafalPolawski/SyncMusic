# Contributing

Thanks for helping! This document covers the development setup, conventions and the release process.

## Setup

- Go 1.26 or newer
- Node.js 22 or newer (24 LTS recommended)
- ffmpeg/ffprobe (scanning, transcoding and many tests use the real tools)
- Optional: Docker, [golangci-lint](https://golangci-lint.run) v2

```sh
make web     # npm ci + build the client into internal/webui/dist (embedded in the binary)
make run     # server on :8080 using ./music and ./data
make dev     # Vite dev server on :5173 with hot reload, proxying /api to :8080
```

`make help` lists all targets.

## Project layout

See [docs/architecture.md](docs/architecture.md#code-map). The short version: Go code lives in `internal/` (one package per concern), the web client in `web/src`, and both share the timeline contract in `testdata/sync/timeline.json`.

## Tests

| Command | What runs |
|---|---|
| `make test-go` | Go unit and integration tests with the race detector. They generate real audio with ffmpeg; set `SYNCMUSIC_REQUIRE_FFMPEG=1` to fail instead of skip when ffmpeg is missing (CI does). |
| `make test-web` | Vitest unit and component tests. |
| `make e2e` | Playwright tests against a real server with generated music, emulating two Android phones. `PW_CHROMIUM=/path/to/chrome` uses a preinstalled Chromium. |
| `make lint` | golangci-lint, ESLint, TypeScript and Prettier. |
| `make screenshots` | Regenerates the images in `docs/images/` from the real app: a demo library with generated cover art, a server and three emulated phones in one room, in English and Polish, plus a banner per language for the top of the README (the English one doubles as the repository's social preview; `-- banner` rebuilds only the banners). Run it after visible UI changes. |

**Changing the room timeline?** Update `internal/room/timeline.go` and `web/src/sync/timeline.ts` together and add a case to `testdata/sync/timeline.json`. Both test suites must agree, otherwise offline phones drift away from the server.

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `build:`, `ci:`, `chore:`, `refactor:`, `test:`). `!` marks breaking changes.
- Go: `gofmt`/`goimports`, errors wrapped with context, no global state outside `main`.
- Web: TypeScript strict mode, Prettier formatting, components as functions, state in small Zustand stores.
- User-facing text lives in `web/src/i18n` (Polish and English, keep both in sync).

## Releasing

1. Update `CHANGELOG.md`: move entries from *Unreleased* to a new version heading.
2. Tag and push:
   ```sh
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```
   Or, without a local checkout: *Actions → Publish → Run workflow* on `main` with the version `v1.2.3`. The tag is created on that commit once everything below succeeded.
3. The **Publish** workflow runs CI, builds `linux/amd64` and `linux/arm64` images natively, pushes `ghcr.io/rafalpolawski/syncmusic:1.2.3`, `:1.2`, `:1` and `:latest`, cross-compiles binaries and creates the GitHub release with generated notes. Tags with a suffix (`v1.3.0-rc.1`) become pre-releases and do not move `latest`.

Every push to `main` publishes the `:edge` image. The **Clean up images** workflow runs weekly and removes images no tag points to any more (old `:edge` builds); run it by hand with tags to remove, for example `sha-*`, and *dry run* to see what it would do first.

## Reporting security issues

See [SECURITY.md](SECURITY.md).
