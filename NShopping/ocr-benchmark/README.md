# OCR latency benchmark (Qwen2.5-VL on RX 580 via Vulkan, or CPU)

Measures how fast handwritten-text OCR runs on your hardware, so you can decide whether
the RX 580 (or CPU) is fast enough for a "take a photo" feature in the Bulk editor.

Everything runs in Docker. The **only** things the host must provide are the `amdgpu`
kernel driver and `/dev/dri` — no ROCm, no Vulkan libraries, no build tools. This matters
because the RX 580 is Polaris (`gfx803`), which modern ROCm/Ollama no longer support; the
container drives it through **Mesa RADV over Vulkan** instead.

## Usage

On the Linux box with the RX 580:

```bash
cd ocr-benchmark
./run.sh /path/to/PXL_20260802_194940316.jpg
```

First build takes a few minutes (it compiles llama.cpp). The first run also downloads the
model (~2.5GB) into `.ocr-cache/`, which is reused afterwards.

## Two benchmarks

- **`./run.sh <photo>`** — one-shot smoke test. Reloads the model every call, so its
  wall-clock **includes model load + VRAM upload** and *overstates* real latency. Good for
  "does it work at all" and eyeballing OCR quality per resolution.
- **`./run-server.sh <photo>`** — the honest latency test. Starts `llama-server` once per
  backend (model **resident**, upload off-clock), then times repeated requests and prints
  the **prefill-vs-generation split**. This is the number that answers "can we stay
  CPU-only?" — if CPU BEST is under 5000ms, the RX 580 is optional.

  ```bash
  ./run-server.sh /path/to/PXL_20260802_194940316.jpg
  RES=1024 ITERS=8 ./run-server.sh photo.jpg   # tune resolution / sample count
  ```

## What the one-shot benchmark does

For each resolution in `768 1024 1536` (long-edge px), it runs OCR twice — once on the
**GPU (Vulkan)** and once on the **CPU** — and prints wall-clock latency plus the extracted
text. A warmup run (untimed) first downloads weights and compiles the Vulkan pipelines so
those one-time costs don't skew the numbers.

## Reading the results

- **GPU-Vulkan rows** — does the RX 580 clear your latency bar? Expect low-single-digit
  seconds at 768–1024px for the 3B model.
- **CPU rows** — can the no-GPU fallback hit <5s? For the 3B model, probably not (image
  prefill on CPU is slow); if these are too slow, that's the signal to either use the GPU
  or drop to a smaller OCR-specialized model (see below).
- **Resolution** — smaller long-edge is faster but lossier. Find the smallest size that
  still reads the handwriting correctly; that's your production setting. Pre-resizing is
  the biggest speed lever because it directly cuts the number of vision tokens.

## Knobs

```bash
# Try the 7B model (tighter fit on 8GB, slower, more accurate):
./run.sh photo.jpg ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M

# Change resolutions / output length (env vars, passed through to the container):
RESOLUTIONS="640 896" MAX_TOKENS=128 ./run.sh photo.jpg   # (edit run.sh to forward these, or run benchmark.sh directly)
```

## If CPU needs to be <5s

The 3B VLM likely won't make it on CPU. Smaller, OCR-specialized models that can are worth
a separate spike: **GOT-OCR2.0** (~580M), **SmolVLM-500M**, or **TrOCR-handwritten**
(purpose-built for handwriting, needs line segmentation). They're faster but less accurate
on messy handwriting — lean on fuzzy-matching the output against your known grocery/product
list to recover the difference.

## Troubleshooting

- **`vulkaninfo` shows no device / GPU falls back to CPU** — `/dev/dri` isn't reaching the
  container. Confirm `ls /dev/dri` on the host shows `card0` and `renderD128`.
- **Permission denied on `renderD128`** — only if you changed the container to run non-root;
  add `--group-add "$(getent group render | cut -d: -f3)"` to the `docker run` in `run.sh`.
- **mmproj / vision projector error in warmup** — the repo's vision file wasn't auto-fetched;
  pass it explicitly with `--mmproj-url <mmproj .gguf on the HF repo>` (see benchmark.sh).
