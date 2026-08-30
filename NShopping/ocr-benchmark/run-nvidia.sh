#!/usr/bin/env bash
# Build the Nvidia image and run the OCR benchmark against a photo, with the GPU passed
# through via CUDA. Run this ON THE LINUX BOX WITH THE GTX 1070.
#
#   ./run-nvidia.sh /path/to/PXL_20260802_194940316.jpg
#
# Requirements on the host: docker, the nvidia driver (580.x), and the
# nvidia-container-toolkit configured so `docker run --gpus` works.
# Nothing else — no CUDA toolkit needed on the host.
set -euo pipefail

IMG_FILE="${1:?Usage: ./run-nvidia.sh <path-to-photo.jpg> [hf-repo:quant]}"
HF_REPO="${2:-}"

IMG_DIR="$(cd "$(dirname "$IMG_FILE")" && pwd)"
IMG_NAME="$(basename "$IMG_FILE")"
CACHE_DIR="$IMG_DIR/.ocr-cache"

cd "$(dirname "$0")"

echo ">>> Building image (first build compiles llama.cpp — a few minutes)..."
docker build -f Dockerfile.nvidia -t ocr-bench-nvidia .

mkdir -p "$CACHE_DIR"

echo ">>> Running benchmark..."
docker run --rm \
  --gpus all \
  -v "$IMG_DIR:/data" \
  -v "$CACHE_DIR:/root/.cache" \
  ocr-bench-nvidia "/data/$IMG_NAME" ${HF_REPO:+"$HF_REPO"}
