# Frontend — Single Multi-stage Dockerfile
# Supports both Hot-Reload Development and Static Production Builds.

# Stage 1: Base (Dependencies)
FROM node:25-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Stage 2: Development (Hot Reload)
FROM base AS development
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]

# Stage 3: Build (Static Assets)
FROM base AS builder
COPY . .
RUN npm run build

# Stage 4: Production (Minimal Assets for Caddy)
FROM scratch AS production
COPY --from=builder /app/dist /usr/share/caddy
# This stage does nothing but holds files for the Caddy volume mount.
CMD [""]
