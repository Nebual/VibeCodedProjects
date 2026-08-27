#!/bin/bash
# Builds the MuScriptor sidecar image. Run by hand when adopting a new upstream
# version — deliberately NOT part of bin/gman-deploy.sh, whose `up --build` would
# otherwise re-run a multi-minute torch+MuseScore build on every single deploy.
#
# The build context is a git URL, so there is nothing vendored into this repo and
# upstream's Dockerfile is used unmodified.
#
# WHY A COMMIT AND NOT A TAG: sheet-music engraving (`POST /sheets`) landed on main
# after v0.3.0 and no release carries it yet, so the newest tag cannot engrave at all.
# This is pinned to the commit rather than to `main` because a moving branch would
# silently change the SSE payload shape that server/utils/midiWorker.ts treats as a
# contract. Verified against this commit: /sheets exists, and the /transcribe event
# shapes are unchanged from v0.3.0 (the diff is purely additive — /sheets, plus a
# `quantized_midi` field we don't rely on).
#
# Re-read muscriptor/server.py before moving this, and re-run the checks in the
# "Audio → MIDI" section of AGENTS.md.
#
# The MuseScore AppImage URL in their Dockerfile is x86_64-only. That's fine for the
# server; on an arm64 dev machine the `AppRun --version` check fails and you need:
#   ./bin/build-midi-sidecar.sh <ref> <tag> --build-arg MUSESCORE_URL=<arm64 AppImage url>
set -e

# main @ 2026-08-20, "Quantize before exporting sheet music (#93)".
DEFAULT_REF=e34b397bf0584e67bfd81dc591c390e6dcb03350
DEFAULT_TAG=main-e34b397

REF="${1:-$DEFAULT_REF}"
TAG="${2:-$DEFAULT_TAG}"
# Anything after <ref> <tag> is passed straight through to `docker build`.
EXTRA=()
if [ $# -gt 2 ]; then EXTRA=("${@:3}"); fi

docker build -t "songtrack-midi:$TAG" "${EXTRA[@]}" \
  "https://github.com/muscriptor/muscriptor.git#$REF"
echo "Built songtrack-midi:$TAG from $REF"
echo "docker-compose.yml must reference this same tag."
