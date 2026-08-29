#!/bin/bash
# Deploy script — runs on the production server.
# Usage (from anywhere): ssh gman@gman '/servers/nshopping/NShopping/bin/gman-deploy.sh'
# Or via the repo: pnpm gman-deploy
set -e
cd /servers/nshopping/NShopping
# Build while old server keeps serving
git pull --rebase --autostash

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use
pnpm build

# Restart inside the existing screen session:
# send Ctrl-C to stop the current server...
screen -S nshopping -p 0 -X stuff $'\003'
sleep 0.5
# ...then start the new one and press Enter
screen -S nshopping -p 0 -X stuff 'pnpm start\n'

echo "Deploy complete"
