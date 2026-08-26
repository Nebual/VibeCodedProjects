#!/bin/bash
# Deploy script — runs on the production server.
# Usage (from anywhere): ssh gman@gman '/servers/songtrack/Songtrack/bin/gman-deploy.sh'
# Or via the repo: pnpm gman-deploy
set -e
cd /servers/songtrack/Songtrack
# Build while old server keeps serving
git pull --rebase --autostash

docker compose up --build -d

echo "Deploy complete"
