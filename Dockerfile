# syntax=docker/dockerfile:1

# ---- build: compile TypeScript with dev dependencies present ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps: production-only node_modules, resolved separately so the
#      compiler and its tree never reach the final image ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Downloaded documents land here; mount a volume over it to keep them.
RUN mkdir -p /downloads && chown node:node /downloads
VOLUME ["/downloads"]

# HTTP is the default in the image because a container is a long-running
# service. Override MCP_TRANSPORT=stdio to run it as a one-shot stdio server.
ENV MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8765 \
    PAPERLESS_DOWNLOAD_DIR=/downloads

EXPOSE 8765
USER node

# Liveness only: deliberately does not touch paperless, so an archive outage
# does not cause the container to be restarted in a loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8765)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/index.js"]
