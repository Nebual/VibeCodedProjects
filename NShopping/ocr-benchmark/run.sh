#!/usr/bin/env bash
# Build the image and run the OCR benchmark against a photo, with the AMD GPU passed
# through. Run this ON THE LINUX BOX WITH THE RX 580.
#
#   ./run.sh /path/to/PXL_20260802_194940316.jpg
#
# Requirements on the host: docker, an amdgpu-driven card, and /dev/dri present.
# Nothing else — no ROCm, no Vulkan libs, no build tools on the host.
set -euo pipefail

IMG_FILE="${1:?Usage: ./run.sh <path-to-photo.jpg> [hf-repo:quant]}"
HF_REPO="${2:-}"

IMG_DIR="$(cd "$(dirname "$IMG_FILE")" && pwd)"
IMG_NAME="$(basename "$IMG_FILE")"
CACHE_DIR="$IMG_DIR/.ocr-cache"

cd "$(dirname "$0")"

echo ">>> Building image (first build compiles llama.cpp — a few minutes)..."
docker build -t ocr-bench .

mkdir -p "$CACHE_DIR"

# --device /dev/dri  : exposes card0 + renderD128 so RADV can drive the GPU.
# The container runs as root, so it can open the render node without --group-add.
# If you run it non-root and hit a permission error on /dev/dri/renderD128, add:
#     --group-add "$(getent group render | cut -d: -f3)"
# Note: only /dev/dri is needed. /dev/kfd (the ROCm compute node) is deliberately
# NOT passed through, because we're using Vulkan, not ROCm.
echo ">>> Running benchmark..."
docker run --rm \
  --device /dev/dri \
  -v "$IMG_DIR:/data" \
  -v "$CACHE_DIR:/root/.cache" \
  ocr-bench "/data/$IMG_NAME" ${HF_REPO:+"$HF_REPO"}
