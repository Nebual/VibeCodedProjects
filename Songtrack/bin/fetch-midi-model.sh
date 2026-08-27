#!/bin/bash
# Pre-populates the MuScriptor model cache so the sidecar never needs network or
# HuggingFace credentials at runtime. Run this by hand, not from a build or a deploy.
#
#   1. Make a free HuggingFace account.
#   2. Accept the CC BY-NC 4.0 licence at https://huggingface.co/MuScriptor/muscriptor-small
#      (access is granted automatically, no waiting).
#   3. Create a read token at https://huggingface.co/settings/tokens and export it:
#        export HF_TOKEN=hf_...
#   4. ./bin/fetch-midi-model.sh [small|medium|large]
#
# Defaults to <repo>/cache/midi-cache, which docker-compose.yml mounts read-only at /hf-cache.
#
# Downloading the whole repo (not just the .safetensors) is deliberate: it pulls the
# config.json sibling that MuScriptor's download_companion looks for to detect the
# architecture. Mount the cache DIRECTORY into the container, never a single file.
set -e
MODEL="${1:-small}"
CACHE="${MIDI_MODEL_CACHE:-$(cd "$(dirname "$0")/.." && pwd)/cache/midi-cache}"
mkdir -p "$CACHE"
HF_HOME="$CACHE" uvx --from huggingface_hub hf download "MuScriptor/muscriptor-$MODEL"

# The soundfonts too, and this is not optional. The upstream image prewarms them into its OWN
# default HF cache, so the moment compose points HF_HOME at this volume they become invisible and
# HF_HUB_OFFLINE=1 forbids fetching them — /auralize and /soundfonts/… then fail with a bare 500.
# This repo is public, ungated and MIT (only the model weights are CC BY-NC), so no token needed.
HF_HOME="$CACHE" uvx --from huggingface_hub hf download "MuScriptor/assets"

echo "Cached MuScriptor/muscriptor-$MODEL and MuScriptor/assets under $CACHE"
