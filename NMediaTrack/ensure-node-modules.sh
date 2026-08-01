#!/usr/bin/env bash
# This project lives on a filesystem that does not support symlinks, which
# breaks pnpm/node_modules. As a workaround, node_modules is a bind mount from a
# native-filesystem directory. Run this after a sandbox restart to restore it.
set -e
PROJ="/c/Users/ben11/Documents/Claude Experiments/NMediaTrack"
NATIVE="/home/agent/nmedia_nm"
mkdir -p "$NATIVE" "$PROJ/node_modules"
if [ "$(ls -A "$PROJ/node_modules" 2>/dev/null | wc -l)" = "0" ]; then
  sudo mount --bind "$NATIVE" "$PROJ/node_modules"
  echo "node_modules bind mount restored."
else
  echo "node_modules already populated."
fi
