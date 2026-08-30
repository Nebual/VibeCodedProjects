#!/usr/bin/env bash
# Build the Nvidia image and run the PERSISTENT-SERVER benchmark (true per-photo latency,
# model kept resident). Run this ON THE LINUX BOX WITH THE GTX 1070.
#
#   ./run-server-nvidia.sh /path/to/PXL_20260802_194940316.jpg
#
# Tune via env vars, e.g.:  RES=1024 ITERS=8 ./run-server-nvidia.sh photo.jpg
set -euo pipefail

IMG_FILE="${1:?Usage: ./run-server-nvidia.sh <path-to-photo.jpg> [hf-repo:quant]}"
HF_REPO="${2:-}"

IMG_DIR="$(cd "$(dirname "$IMG_FILE")" && pwd)"
IMG_NAME="$(basename "$IMG_FILE")"
CACHE_DIR="$IMG_DIR/.ocr-cache"

cd "$(dirname "$0")"

echo ">>> Building image..."
docker build -f Dockerfile.nvidia -t ocr-bench-nvidia .

mkdir -p "$CACHE_DIR"

echo ">>> Running persistent-server benchmark..."
# Reuses the same weights cache as the one-shot benchmark, so no re-download.
# -e passes RES/ITERS/MAX_TOKENS through only if set in your shell.
docker run --rm \
  --gpus all \
  -e RES -e ITERS -e MAX_TOKENS \
  -v "$IMG_DIR:/data" \
  -v "$CACHE_DIR:/root/.cache" \
  --entrypoint /usr/local/bin/server-benchmark.sh \
  ocr-bench-nvidia "/data/$IMG_NAME" ${HF_REPO:+"$HF_REPO"}
