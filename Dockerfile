# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage ----------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

ENV BEACON_HOST=0.0.0.0 \
    BEACON_DATA_DIR=/data \
    BEACON_WEB_DIR=/app/web/dist
# Port defaults to 7700 via config (BEACON_PORT / PORT). Compose keeps 7700;
# Vercel uses Dockerfile.vercel and the platform PORT.

VOLUME ["/data"]
EXPOSE 7700

RUN addgroup -S beacon && adduser -S beacon -G beacon && mkdir -p /data && chown beacon:beacon /data
USER beacon

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BEACON_PORT||7700)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
