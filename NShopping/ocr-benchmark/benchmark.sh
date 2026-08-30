#!/usr/bin/env bash
# OCR latency benchmark for Qwen2.5-VL via llama.cpp.
#
# For each input resolution, runs the model on GPU (Vulkan) and on CPU, and prints
# wall-clock latency plus the extracted text. Pre-resizing the image is the single
# biggest latency lever for Qwen2.5-VL (fewer pixels -> fewer vision tokens to encode
# and prefill), so we sweep a few sizes to show the tradeoff.
set -euo pipefail

IMG="${1:?Usage: benchmark.sh <image-file> [hf-repo:quant]}"
# 3B Q4_K_M: ~2.5GB weights + ~0.8GB vision encoder — fits the RX 580's 8GB with headroom.
HF_REPO="${2:-ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M}"

# Long-edge sizes (px) to test. A grocery list needs far less than a full-res phone photo.
RESOLUTIONS="${RESOLUTIONS:-768 1024 1536}"
MAX_TOKENS="${MAX_TOKENS:-256}"

PROMPT='OCR this image. Transcribe every line of handwritten and printed text exactly as written, one item per line. Output only the transcription, with no commentary.'

echo "==================================================================="
echo " OCR benchmark — model: ${HF_REPO}"
echo " input image: ${IMG}"
echo "==================================================================="
echo
GPU_LABEL="GPU-Vulkan"
if [ "${GPU_BACKEND:-vulkan}" = "cuda" ]; then
  GPU_LABEL="GPU-CUDA"
  echo "--- CUDA devices (your Nvidia GPU should appear here) ---"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv 2>/dev/null || \
    echo "  (nvidia-smi found no device — GPU runs will fall back to CPU; check --gpus passthrough)"
else
  echo "--- Vulkan devices (your RX 580 should appear here via RADV) ---"
  vulkaninfo --summary 2>/dev/null | grep -iE "deviceName|driverName|apiVersion" || \
    echo "  (vulkaninfo found no device — GPU runs will fall back to CPU; check /dev/dri passthrough)"
fi
echo

# One untimed warmup: downloads the weights AND compiles the Vulkan compute pipelines,
# both of which are one-time costs that would otherwise pollute the first measurement.
echo "--- Warmup (download + Vulkan pipeline compile — NOT timed) ---"
convert "$IMG" -resize "512x512>" /tmp/warm.png
if llama-mtmd-cli -hf "$HF_REPO" --image /tmp/warm.png -p "hi" -ngl 99 -n 4 \
     >/tmp/warm.log 2>&1; then
  echo "  warmup OK"
else
  echo "  warmup FAILED — dumping log:"
  tail -n 30 /tmp/warm.log
  echo "  (if this is an mmproj error, the repo's vision projector wasn't auto-fetched;"
  echo "   re-run adding: --mmproj-url <mmproj gguf on the HF repo>)"
  exit 1
fi
echo

run_one () {
  local label="$1" ngl="$2" res="$3"
  local resized="/tmp/ocr_${res}.png"
  # Never upscale ('>' only shrinks). Long edge capped at ${res}px.
  convert "$IMG" -resize "${res}x${res}>" "$resized"
  local dims; dims=$(identify -format '%wx%h' "$resized")

  echo "----- ${label} | long-edge ${res}px (actual ${dims}) -----"
  local start end wall
  start=$(date +%s.%N)
  if llama-mtmd-cli -hf "$HF_REPO" --image "$resized" -p "$PROMPT" \
        -ngl "$ngl" --temp 0 -n "$MAX_TOKENS" >/tmp/out.log 2>/tmp/err.log; then
    end=$(date +%s.%N)
    wall=$(echo "$end - $start" | bc)
    # llama.cpp's own timings give the prefill-vs-generate split.
    grep -E "prompt eval time|eval time =|total time" /tmp/err.log | sed 's/^/  timing: /' || true
    printf "  >>> WALL CLOCK: %.2fs\n" "$wall"
    echo "  --- extracted text ---"
    sed 's/^/  | /' /tmp/out.log
  else
    echo "  RUN FAILED:"
    tail -n 20 /tmp/err.log
  fi
  echo
}

echo "########## GPU (${GPU_LABEL}, all layers offloaded) ##########"
echo
for res in $RESOLUTIONS; do
  run_one "$GPU_LABEL" 99 "$res"
done

echo "########## CPU (no GPU offload) ##########"
echo
for res in $RESOLUTIONS; do
  run_one "CPU" 0 "$res"
done

echo "==================================================================="
echo " Done. Compare WALL CLOCK across rows:"
echo "   - GPU rows tell you if the GPU clears your latency bar."
echo "   - CPU rows tell you if the no-GPU fallback can hit <5s."
echo "   - Smaller long-edge = faster but lossier; find the smallest"
echo "     resolution that still reads the handwriting correctly."
echo "==================================================================="
