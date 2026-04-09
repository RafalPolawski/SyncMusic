FROM caddy:2-builder-alpine AS builder

# Build Caddy WITHOUT the Tailscale module.
# The stock caddy:2-alpine includes a Tailscale cert provider that tries
# to connect to tailscaled.sock - which doesn't exist inside Docker.
# This custom build strips it out so on_demand_tls uses only the internal CA.
RUN xcaddy build

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
