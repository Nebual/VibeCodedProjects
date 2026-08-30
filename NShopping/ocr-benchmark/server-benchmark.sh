#!/usr/bin/env bash
# Persistent-server OCR latency benchmark.
#
# Unlike benchmark.sh (which reloads the model every invocation), this starts
# llama-server ONCE per backend so the model stays resident and the VRAM upload
# happens off-clock during startup. The timed requests then measure the REAL
# per-photo latency a Bulk-editor endpoint would deliver: HTTP + prefill + generation.
#
# For each request it reports wall-clock plus the server's own prefill/generation
# split, so you can see whether CPU is viable (generation-bound, GPU gap smaller)
# or whether prefill (resolution-bound, GPU's strength) forces the GPU.
set -uo pipefail   # NOTE: deliberately no -e; we handle curl failures explicitly.

IMG="${1:?Usage: server-benchmark.sh <image-file> [hf-repo:quant]}"
HF_REPO="${2:-ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M}"
RES="${RES:-768}"          # long-edge px; 768 was judged good enough
ITERS="${ITERS:-5}"        # timed requests per backend
MAX_TOKENS="${MAX_TOKENS:-256}"
HOST=127.0.0.1
PORT=8080

PROMPT='OCR this image. Transcribe every line of handwritten and printed text exactly as written, one item per line. Output only the transcription, with no commentary.'

# Resize ONCE. Every iteration sends the identical image, so at temp 0 the output
# (and token counts) are identical across iterations — latency differences reflect
# the backend, not generation-length variance (the thing that skewed the last run).
convert "$IMG" -resize "${RES}x${RES}>" /tmp/in.png
DIMS=$(identify -format '%wx%h' /tmp/in.png)

# Build the request body to a file. The base64 image is large, so it must never touch
# argv: write the data URI to a file and let jq read it via --rawfile (a CLI --arg would
# blow ARG_MAX), and send it to curl with -d @file for the same reason.
# cache_prompt:false so the server re-does the vision prefill every time, matching
# production where each photo is unique (otherwise iters 2+ would cheat via cache).
{ printf 'data:image/png;base64,'; base64 -w0 /tmp/in.png; } > /tmp/uri.txt
jq -n --arg p "$PROMPT" --argjson n "$MAX_TOKENS" --rawfile u /tmp/uri.txt '{
  messages: [ { role:"user", content: [
    {type:"text",      text: $p},
    {type:"image_url", image_url: {url: $u}}
  ] } ],
  temperature: 0,
  max_tokens: $n,
  cache_prompt: false
}' > /tmp/req.json

CHAT_URL="http://${HOST}:${PORT}/v1/chat/completions"

bench_backend () {
  local label="$1" ngl="$2"
  echo "############################################################"
  echo "## ${label}   (long-edge ${RES}px = ${DIMS}, model resident)"
  echo "############################################################"

  # Model load + (for GPU) VRAM upload happen here, ONCE, off the clock.
  llama-server -hf "$HF_REPO" -ngl "$ngl" \
      --host "$HOST" --port "$PORT" -c 8192 \
      >/tmp/server.log 2>&1 &
  local pid=$!

  echo -n "  loading model"
  local ready=0 i
  for i in $(seq 1 180); do
    if curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo " — SERVER DIED:"; tail -n 30 /tmp/server.log; return 1
    fi
    echo -n "."; sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo " — TIMED OUT waiting for /health"; tail -n 30 /tmp/server.log
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 1
  fi
  echo " — ready"

  # Surface which device the backend actually chose (guards against silent CPU fallback).
  grep -iE "using device|ggml_vulkan|ggml_cuda|POLARIS|llvmpipe|found.*compute capability|load_tensors: .*buffer" /tmp/server.log \
    | sed 's/^/  [server] /' | head -n 4

  # Untimed warmup: compiles Vulkan pipelines, faults in pages.
  curl -sf "$CHAT_URL" -H 'Content-Type: application/json' -d @/tmp/req.json \
       >/tmp/warm.json 2>/dev/null

  echo "  --- ${ITERS} timed requests ---"
  local best=99999999 sum=0 last_resp="/tmp/resp.json"
  for i in $(seq 1 "$ITERS"); do
    local start end wall
    start=$(date +%s.%N)
    if ! curl -sf "$CHAT_URL" -H 'Content-Type: application/json' -d @/tmp/req.json \
         >"$last_resp" 2>/dev/null; then
      echo "    req $i: FAILED"; continue
    fi
    end=$(date +%s.%N)
    wall=$(echo "($end - $start)*1000/1" | bc)

    # Server-side split. Fields may be absent on some builds -> print n/a.
    local split
    split=$(jq -r '
      if .timings then
        "prefill \(.timings.prompt_ms|floor)ms/\(.timings.prompt_n)tok  |  gen \(.timings.predicted_ms|floor)ms/\(.timings.predicted_n)tok (\(.timings.predicted_per_second|floor) tok/s)"
      else "server timings n/a" end' "$last_resp" 2>/dev/null)
    printf "    req %d: wall %5sms   [%s]\n" "$i" "$wall" "$split"

    sum=$((sum + wall))
    if [ "$wall" -lt "$best" ]; then best=$wall; fi
  done

  echo "  --- extracted text (last request) ---"
  jq -r '.choices[0].message.content // "(no content)"' "$last_resp" 2>/dev/null | sed 's/^/    | /'
  printf "  >>> %s @ %spx: BEST %sms, avg %sms\n" "$label" "$RES" "$best" "$((sum / ITERS))"
  echo

  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
}

echo "=================================================================="
echo " Persistent-server OCR benchmark — ${HF_REPO}"
echo " image: ${IMG}   long-edge: ${RES}px   iters: ${ITERS}"
echo "=================================================================="
GPU_LABEL="GPU-Vulkan"
if [ "${GPU_BACKEND:-vulkan}" = "cuda" ]; then
  GPU_LABEL="GPU-CUDA"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv 2>/dev/null | sed 's/^/  /' || echo "  (no nvidia-smi)"
else
  vulkaninfo --summary 2>/dev/null | grep -iE "deviceName|driverName" | sed 's/^/  /' || echo "  (no vulkaninfo)"
fi
echo

bench_backend "$GPU_LABEL" 99
bench_backend "CPU"        0

echo "=================================================================="
echo " Read the BEST lines. That's true per-photo latency, model resident."
echo "   - CPU BEST < 5000ms  -> ship CPU-only, RX 580 optional."
echo "   - Otherwise, compare the [prefill vs gen] splits: if prefill is what"
echo "     blows the budget on CPU, the GPU (which crushes prefill) is worth it."
echo "=================================================================="
