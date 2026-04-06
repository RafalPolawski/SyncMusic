# Frontend — build stage
FROM node:25-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --prefer-offline; else npm install; fi

COPY . .
RUN npm run build

# Stage 2: provide only built assets
FROM scratch
COPY --from=builder /app/dist /usr/share/caddy
# This image does nothing but holds the files. We'll mount it to Caddy.
CMD [""]
