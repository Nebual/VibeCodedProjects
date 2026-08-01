FROM mcr.microsoft.com/devcontainers/javascript-node:24

# pnpm via corepack (version comes from package.json packageManager if set)
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && mkdir -p "$PNPM_HOME" && chown -R node:node /home/node/.local
