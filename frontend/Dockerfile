# Frontend — multi-stage production build
# Stage 1: build the Vite app
FROM node:25-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --prefer-offline

COPY . .
RUN npm run build

# Stage 2: serve with nginx
FROM nginx:1.29-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
