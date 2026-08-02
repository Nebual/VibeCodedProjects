# Build context is the repo root, not web/, because the pnpm workspace manifests
# live there. See docker-compose.yml.
FROM node:24-slim AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

COPY web ./web
RUN pnpm --filter web build

FROM node:24-slim
WORKDIR /app

COPY --from=build /app/web/.output ./.output

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
