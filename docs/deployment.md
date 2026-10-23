# Deployment

SyncMusic is one process. The only real requirement is **HTTPS** for the phones: browsers only allow installing the app, offline caching and lock-screen controls on secure origins. Over the internet or between networks the easiest way to get HTTPS is [Tailscale](https://tailscale.com), which needs no port forwarding and gives you valid certificates.

## Option A: Docker on a machine that already runs Tailscale

```sh
cp .env.example .env        # set MUSIC_DIR and SYNCMUSIC_PASSWORD
docker compose up -d
tailscale serve --bg 8080
```

The app is now at `https://<machine>.<tailnet>.ts.net`. Invite your friends to your tailnet (or [share the machine](https://tailscale.com/kb/1084/sharing)) and have them install the Tailscale app on their phones.

Set `SYNCMUSIC_TRUST_PROXY=true` in `.env` so the server sees the real client addresses behind `tailscale serve`.

## Option B: Tailscale sidecar container

[`compose.tailscale.yaml`](../compose.tailscale.yaml) runs Tailscale next to SyncMusic in the same network namespace. The server gets its own machine name (`syncmusic` by default) and HTTPS through [Tailscale Serve](https://tailscale.com/kb/1312/serve):

1. In the Tailscale admin console enable **MagicDNS** and **HTTPS certificates**, and create an **auth key**.
2. Add `TS_AUTHKEY=tskey-auth-…` to `.env`.
3. `docker compose -f compose.tailscale.yaml up -d`
4. Open `https://syncmusic.<tailnet>.ts.net`.

No ports are published on the host at all.

## Option C: your own reverse proxy

Any proxy that can forward WebSockets works. Forward everything to `http://syncmusic:8080` and set `SYNCMUSIC_TRUST_PROXY=true`. Example for Caddy:

```
music.example.com {
    reverse_proxy syncmusic:8080
}
```

## Running without Docker

Download an archive for your platform from the [releases page](https://github.com/RafalPolawski/SyncMusic/releases), install `ffmpeg` (which provides `ffprobe` too), and run:

```sh
export SYNCMUSIC_MUSIC_DIR=$HOME/Music SYNCMUSIC_DATA_DIR=$HOME/.local/share/syncmusic SYNCMUSIC_PASSWORD=…
./syncmusic
```

A systemd unit:

```ini
# /etc/systemd/system/syncmusic.service
[Unit]
Description=SyncMusic
After=network-online.target
Wants=network-online.target

[Service]
User=syncmusic
Environment=SYNCMUSIC_MUSIC_DIR=/srv/music
Environment=SYNCMUSIC_DATA_DIR=/var/lib/syncmusic
EnvironmentFile=-/etc/syncmusic.env
ExecStart=/usr/local/bin/syncmusic
Restart=on-failure
StateDirectory=syncmusic
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/syncmusic

[Install]
WantedBy=multi-user.target
```

## Permissions of the music folder

The container runs as user `65532`. The music folder only needs to be readable by it, which is the default for most folders (`chmod -R o+rX /srv/music` if not). Data lives in the `syncmusic-data` volume.

## Updating

```sh
docker compose pull && docker compose up -d
```

The database migrates automatically. Phones show an *update available* banner and switch to the new version when you tap it, so a running song is never interrupted.

## Backups

Only `/data/syncmusic.db` (room state, library index) and `/data/session.key` (logins) matter, and everything else is cache. Losing the database just means a rescan.

## Raspberry Pi and NAS

Images are published for `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5 with a 64-bit OS, most NAS devices). Transcoding costs CPU time, so the server transcodes the upcoming tracks of every room in advance and keeps the results in a cache. If the CPU is too slow for that, set the phones' quality to *Original* or disable transcoding with `SYNCMUSIC_TRANSCODE=false`. A release binary for 32-bit ARM (`armv7`) is available as well.

## Monitoring

`/metrics` exposes Prometheus metrics (connections, rooms, commands, transcode cache hits and durations, Go runtime). Disable with `SYNCMUSIC_METRICS=false`.
