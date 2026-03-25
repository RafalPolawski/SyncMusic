# Backend — multi-stage build
# Stage 1: compile (full Go toolchain)
FROM golang:1.26-alpine AS builder
WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
# CGO_ENABLED=0 — modernc.org/sqlite is pure Go, no C required
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

# Stage 2: minimal runtime image
FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /build/server .

# Music is mounted at runtime via volume; data holds the SQLite DB
RUN mkdir -p /app/music /app/data

EXPOSE 8080
EXPOSE 4433/udp

CMD ["./server"]