# -----------------------------------
# 1. Build Stage (Frontend SPA + Typecheck)
# -----------------------------------
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
# npm downloads are cached between image builds, and since the connection to the npm registry
# sometimes drops mid-download, a failed npm ci runs again.
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000
RUN --mount=type=cache,target=/root/.npm sh -c 'for i in 1 2 3; do npm ci && exit 0; echo "npm ci failed (attempt $i of 3), retrying in 15 s"; sleep 15; done; exit 1'

COPY . .
RUN npm run build

# -----------------------------------
# 2. Final Runner Stage
# -----------------------------------
FROM node:22-slim AS runner

ENV TZ=Europe/Athens
ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

RUN mkdir -p /app/data/events /app/data/uploads

EXPOSE 3001

CMD ["npm", "start"]

