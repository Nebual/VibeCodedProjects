# Vulkan-accelerated llama.cpp for OCR benchmarking on AMD Polaris (RX 580 / gfx803).
#
# Why Vulkan and not ROCm: AMD dropped official ROCm support for Polaris years ago,
# so Ollama's AMD path won't touch an RX 580. Mesa's RADV Vulkan driver still supports
# it perfectly. Everything the benchmark needs is baked into this image, so nothing
# depends on the library versions installed on the host box — the host only has to
# provide the amdgpu kernel driver and the /dev/dri device nodes.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Build + runtime deps:
#   build-essential/cmake/git  - compile llama.cpp
#   libvulkan-dev + glslc      - Vulkan headers + shader compiler required by the Vulkan backend
#   glslang-tools              - provides glslangValidator (a Vulkan build component llama.cpp checks for)
#   spirv-headers              - provides SPIRV-HeadersConfig.cmake, required by ggml-vulkan's CMake
#   mesa-vulkan-drivers        - RADV: the userspace Vulkan driver that talks to the host amdgpu kernel driver
#   vulkan-tools               - vulkaninfo, used by the diagnostic step
#   libssl-dev                 - OpenSSL dev files: llama.cpp's native HTTPS downloader (for -hf) needs an SSL backend
#   imagemagick                - resize the photo to probe the resolution/latency tradeoff
#   bc                         - float math for wall-clock timing
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates pkg-config \
      libvulkan-dev glslc glslang-tools spirv-headers \
      mesa-vulkan-drivers vulkan-tools \
      libssl-dev \
      imagemagick bc curl jq \
    && rm -rf /var/lib/apt/lists/*

# Build llama.cpp with the Vulkan backend. Only the two binaries we need are built,
# to keep the image build time down.
WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
WORKDIR /opt/llama.cpp
RUN cmake -B build -DGGML_VULKAN=ON -DLLAMA_OPENSSL=ON -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j"$(nproc)" \
         --target llama-mtmd-cli llama-cli llama-server \
    && cp build/bin/llama-mtmd-cli build/bin/llama-cli build/bin/llama-server /usr/local/bin/

# Downloaded GGUF weights land here; mount a volume on it to cache across runs.
ENV LLAMA_CACHE=/root/.cache/llama.cpp

COPY benchmark.sh /usr/local/bin/benchmark.sh
COPY server-benchmark.sh /usr/local/bin/server-benchmark.sh
RUN chmod +x /usr/local/bin/benchmark.sh /usr/local/bin/server-benchmark.sh

WORKDIR /data
ENTRYPOINT ["/usr/local/bin/benchmark.sh"]
