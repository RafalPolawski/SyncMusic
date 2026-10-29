# syntax=docker/dockerfile:1.7
#
# SyncMusic container image: one static Go binary with the web client
# embedded, plus a minimal static ffmpeg/ffprobe, on a distroless base.
#
#   docker build -t syncmusic .
#
# Behind a TLS-inspecting proxy pass its CA bundle as a build secret:
#   docker build --secret id=ca,src=/path/to/ca.pem .

ARG GO_VERSION=1.26
ARG NODE_VERSION=24
ARG UBUNTU_VERSION=24.04

# ---- web client (architecture independent, built once) ---------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund
COPY web/ ./
RUN mkdir -p /src/internal/webui/dist && npm run build

# ---- minimal static ffmpeg (audio only) ------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS ffmpeg
ARG FFMPEG_VERSION=8.1.2
ARG FFMPEG_SHA256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
ARG FFMPEG_URL=https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl libopus-dev nasm pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN --mount=type=secret,id=ca,required=false \
    set -e; \
    if [ -f /run/secrets/ca ]; then export CURL_CA_BUNDLE=/run/secrets/ca; fi; \
    curl -fsSL --retry 5 -o ffmpeg.tar.xz "$FFMPEG_URL"; \
    echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir src && tar -xf ffmpeg.tar.xz -C src --strip-components=1
COPY docker/build-ffmpeg.sh /build/
RUN ./build-ffmpeg.sh /build/src /opt/ffmpeg \
    && /opt/ffmpeg/bin/ffmpeg -hide_banner -version | head -n1

# ---- Go server ----------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS server
ARG TARGETOS TARGETARCH TARGETVARIANT
ARG VERSION=dev
ARG COMMIT=""
ARG BUILD_DATE=""
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export SSL_CERT_FILE=/run/secrets/ca; fi; \
    go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web /src/internal/webui/dist ./internal/webui/dist
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -buildvcs=false \
      -ldflags "-s -w \
        -X github.com/RafalPolawski/SyncMusic/internal/buildinfo.Version=${VERSION} \
        -X github.com/RafalPolawski/SyncMusic/internal/buildinfo.Commit=${COMMIT} \
        -X github.com/RafalPolawski/SyncMusic/internal/buildinfo.Date=${BUILD_DATE}" \
      -o /out/syncmusic ./cmd/syncmusic \
    && mkdir -p /out/data /out/music

# ---- runtime ------------------------------------------------------------------
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=server /out/syncmusic /usr/local/bin/syncmusic
COPY --from=server --chown=65532:65532 /out/data /data
COPY --from=server --chown=65532:65532 /out/music /music
ENV SYNCMUSIC_MUSIC_DIR=/music \
    SYNCMUSIC_DATA_DIR=/data \
    SYNCMUSIC_LISTEN=:8080 \
    SYNCMUSIC_FFMPEG=/usr/local/bin/ffmpeg \
    SYNCMUSIC_FFPROBE=/usr/local/bin/ffprobe
USER 65532:65532
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/syncmusic", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/syncmusic"]
CMD ["serve"]
