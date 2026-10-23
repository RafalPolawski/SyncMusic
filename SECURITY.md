# Security policy

SyncMusic is meant to run on a private network (for example a Tailscale tailnet), protected by a shared password. Please still report anything that could let someone bypass the password, read files outside the music folder, or attack other listeners.

## Reporting

Use GitHub's [private vulnerability reporting](https://github.com/RafalPolawski/SyncMusic/security/advisories/new) instead of a public issue. Please include steps to reproduce and the affected version (`syncmusic version`). You will get an answer within a week.

## Supported versions

Only the latest release receives fixes.

## Hardening tips

- Always set `SYNCMUSIC_PASSWORD`.
- Expose the server only over HTTPS (Tailscale Serve or a reverse proxy) and set `SYNCMUSIC_TRUST_PROXY=true` behind a proxy.
- Mount the music folder read-only (the provided compose files do).
- Keep the image up to date (`docker compose pull`). Dependabot keeps the dependencies current.
