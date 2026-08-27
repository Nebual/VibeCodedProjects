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
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (for "import from YouTube") plus deno, which it needs as a JavaScript runtime.
#
# Tracking nightly rather than a pinned version is deliberate: YouTube breaks extraction
# often enough that a pin would mean the feature silently rots between releases.
#
# The ADD line is a cache-buster, not a file anyone reads. Without it Docker reuses this RUN
# layer forever, so `docker compose up --build` would keep re-shipping whatever nightly was
# current the first time the image was built — exactly what tracking nightly is meant to
# avoid. The release JSON changes whenever a new nightly lands, which invalidates the layer.
#
# yt-dlp_linux is the self-contained build, so no python3 is needed in this image. deno is
# required because current yt-dlp deprecated YouTube extraction without a JS runtime ("No
# supported JavaScript runtime could be found… some formats may be missing") and deno is the
# only one it enables by default.
ADD https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest /tmp/yt-dlp-nightly.json
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) ytdlp_asset='yt-dlp_linux';         deno_asset='deno-x86_64-unknown-linux-gnu.zip'  ;; \
      arm64) ytdlp_asset='yt-dlp_linux_aarch64'; deno_asset='deno-aarch64-unknown-linux-gnu.zip' ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/${ytdlp_asset}" \
      -o /usr/local/bin/yt-dlp; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    curl -fsSL "https://github.com/denoland/deno/releases/latest/download/${deno_asset}" -o /tmp/deno.zip; \
    unzip -q /tmp/deno.zip -d /usr/local/bin; \
    chmod 0755 /usr/local/bin/deno; \
    rm -f /tmp/deno.zip /tmp/yt-dlp-nightly.json; \
    yt-dlp --version; \
    deno --version
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
