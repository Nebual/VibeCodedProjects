#!/usr/bin/env bash
# Fetch the sherpa-onnx export of nemotron-speech-streaming-en-0.6b (int8).
# ~632 MB total. Files land in ./model/.
set -euo pipefail

REPO="csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14"
BASE="https://huggingface.co/${REPO}/resolve/main"
DEST="$(dirname "$0")/model"

mkdir -p "$DEST/test_wavs"

for f in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
    echo "==> $f"
    curl -fL --progress-bar -o "$DEST/$f" "$BASE/$f"
done

for f in 0.wav 1.wav 8k.wav trans.txt; do
    echo "==> test_wavs/$f"
    curl -fL --progress-bar -o "$DEST/test_wavs/$f" "$BASE/test_wavs/$f"
done

echo
echo "Done. Model in $DEST"
du -sh "$DEST"
