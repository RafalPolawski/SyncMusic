#!/usr/bin/env bash
# Cross-compiles release archives into dist/. The web client must be built
# first (cd web && npm ci && npm run build) so it gets embedded.
#
# Usage: scripts/build-release.sh <version> [commit]
set -euo pipefail

version=${1:?usage: build-release.sh <version> [commit]}
commit=${2:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}
date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pkg=github.com/RafalPolawski/SyncMusic/internal/buildinfo
ldflags="-s -w -X $pkg.Version=$version -X $pkg.Commit=$commit -X $pkg.Date=$date"

if [ ! -f internal/webui/dist/index.html ]; then
  echo "internal/webui/dist/index.html missing: build the web client first" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist
targets="linux/amd64 linux/arm64 linux/arm/7 darwin/amd64 darwin/arm64 windows/amd64"
for target in $targets; do
  IFS=/ read -r goos goarch goarm <<< "$target"
  name="syncmusic_${version#v}_${goos}_${goarch}${goarm:+v$goarm}"
  work="dist/$name"
  mkdir -p "$work"
  exe=syncmusic
  [ "$goos" = windows ] && exe=syncmusic.exe
  echo "building $name"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch GOARM=$goarm \
    go build -trimpath -buildvcs=false -ldflags "$ldflags" -o "$work/$exe" ./cmd/syncmusic
  cp README.md LICENSE "$work/"
  if [ "$goos" = windows ]; then
    (cd dist && zip -qr "$name.zip" "$name")
  else
    tar -C dist -czf "dist/$name.tar.gz" "$name"
  fi
  rm -rf "$work"
done
(cd dist && sha256sum ./*.tar.gz ./*.zip | sed 's| \./| |' > checksums.txt)
ls -l dist
