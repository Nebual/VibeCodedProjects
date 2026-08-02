#!/usr/bin/env bash
# Download the Kokoro weights.
#
# Run this on every machine that performs synthesis -- the primary host and any
# GPU node. The weights are not in the repository (340 MB, and they are
# immutable release artefacts), so a fresh checkout has none.
#
#   ./scripts/fetch-models.sh [target-dir]     # defaults to ./models
set -euo pipefail

BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
TARGET="${1:-$(cd "$(dirname "$0")/.." && pwd)/models}"

# fp32 only. The int8 build is a third of the size and measured about five
# times slower on every CPU tested, so it is not worth the download.
FILES=(kokoro-v1.0.onnx voices-v1.0.bin)

mkdir -p "$TARGET"
for name in "${FILES[@]}"; do
    if [ -s "$TARGET/$name" ]; then
        echo "have    $name"
        continue
    fi
    echo "fetching $name"
    # Download beside the target and rename, so an interrupted download cannot
    # leave a truncated file that looks complete on the next run.
    curl -fL --progress-bar -o "$TARGET/$name.part" "$BASE/$name"
    mv "$TARGET/$name.part" "$TARGET/$name"
done

echo
echo "models in $TARGET:"
ls -lh "$TARGET" | tail -n +2 | awk '{printf "  %-24s %s\n", $9, $5}'
