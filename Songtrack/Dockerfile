# Pinned to 24.18, not floating 24-slim: Node 24.19.0 shipped a regression in
# ObjectWrap cleanup-hook handling that crashes native NAN-style addons like
# better-sqlite3's Statement finalizer under sustained query load
# ("Assertion failed: (env) != nullptr" in RemoveEnvironmentCleanupHook,
# api/hooks.cc:142) — reproduced directly against this app's own e2e suite.
# Bump only once a Node 24.x patch is confirmed to have fixed this.
FROM node:24.18-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Same base image tag as the build stage, so the better-sqlite3 native addon
# that Nitro copies into .output/server/node_modules matches this glibc/Node
# ABI without needing to recompile here.
FROM node:24.18-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
ENV NITRO_PORT=3000
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
# server/database/migrations (including meta/_journal.json) isn't part of
# Nitro's bundled .output — it's read from real disk at boot by
# server/plugins/00.db-migrate.ts via a `process.cwd()`-relative path, so it
# has to be copied in separately at that same relative path.
COPY --from=build /app/.output ./.output
COPY --from=build /app/server/database/migrations ./server/database/migrations
VOLUME /data
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
