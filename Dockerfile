# -----------------------------------
# 1. Build & Test Stage (Typecheck + Unit Tests + Frontend SPA + Bundled Server)
# -----------------------------------
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000
RUN --mount=type=cache,target=/root/.npm sh -c 'for i in 1 2 3; do npm ci && exit 0; echo "npm ci failed (attempt $i of 3), retrying in 15 s"; sleep 15; done; exit 1'

COPY . .
RUN npm run typecheck && npm test && npm run build

# -----------------------------------
# 2. Final Minimal Runner Stage (~3 MB app payload, no node_modules needed)
# -----------------------------------
FROM node:22-slim AS runner

ENV TZ=Europe/Athens
ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data/events /app/data/uploads

EXPOSE 3001

CMD ["node", "dist/server/index.cjs"]
