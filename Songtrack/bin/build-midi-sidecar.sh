#!/bin/bash
# Builds the MuScriptor sidecar image. Run by hand when adopting a new upstream
# version — deliberately NOT part of bin/gman-deploy.sh, whose `up --build` would
# otherwise re-run a multi-minute torch+MuseScore build on every single deploy.
#
# WHY A COMMIT AND NOT A TAG: sheet-music engraving (`POST /sheets`) landed on main
# after v0.3.0 and no release carries it yet, so the newest tag cannot engrave at all.
# Pinned to the commit rather than to `main` because a moving branch would silently
# change the SSE payload shape that server/utils/midiWorker.ts treats as a contract.
#
# WHY WE PATCH: two things Songtrack needs that upstream doesn't do (see
# patches/0001-mscz-export-and-tempo-hint.patch for the full rationale):
#   1. `.mscz` — upstream builds score.mscx in a temp dir and throws it away.
#   2. `tempo_hint` — when the beats don't fit a constant tempo, upstream raises and
#      the BPM it *did* fit survives only inside the exception's message text. That
#      number is a far better default than a 120 placeholder.
# Both are small and additive, and worth offering upstream. If they land there, drop
# the patch and go back to building straight from the git URL.
#
# The MuseScore AppImage URL in their Dockerfile is x86_64-only. That's fine for the
# server; on an arm64 dev machine the `AppRun --version` check fails and you need:
#   ./bin/build-midi-sidecar.sh <ref> <tag> --build-arg MUSESCORE_URL=<arm64 AppImage url>
set -e

# main @ 2026-08-20, "Quantize before exporting sheet music (#93)".
DEFAULT_REF=e34b397bf0584e67bfd81dc591c390e6dcb03350
DEFAULT_TAG=main-e34b397-patched

REF="${1:-$DEFAULT_REF}"
TAG="${2:-$DEFAULT_TAG}"
# Anything after <ref> <tag> is passed straight through to `docker build`.
EXTRA=()
if [ $# -gt 2 ]; then EXTRA=("${@:3}"); fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_DIR="$REPO_ROOT/patches"

# A patched build can't use a git URL as its context, so clone into a scratch dir.
WORK="$(mktemp -d -t songtrack-midi-build-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "Cloning muscriptor @ $REF ..."
git clone --quiet "https://github.com/muscriptor/muscriptor.git" "$WORK/src"
git -C "$WORK/src" checkout --quiet "$REF"

# Building unpatched would silently produce an image with no .mscz and no tempo hint,
# which surfaces later as an app bug rather than a build one. Refuse instead.
shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
shopt -u nullglob
if [ ${#PATCHES[@]} -eq 0 ]; then
  echo "No patches found in $PATCH_DIR — refusing to build an unpatched image." >&2
  echo "If that is deliberate, build from the git URL directly." >&2
  exit 1
fi

for patch in "${PATCHES[@]}"; do
  echo "Applying $(basename "$patch") ..."
  # Fail loudly rather than building a half-patched image: a silently-skipped patch
  # means no .mscz and no tempo hint, which would look like an app bug, not a build one.
  git -C "$WORK/src" apply "$patch"
done

docker build -t "songtrack-midi:$TAG" "${EXTRA[@]}" "$WORK/src"
echo "Built songtrack-midi:$TAG from $REF + ${#PATCHES[@]} patch(es)"
echo "docker-compose.yml must reference this same tag."
