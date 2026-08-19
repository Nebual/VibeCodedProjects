# syntax=docker/dockerfile:1
#
# Builds llama.cpp with CUDA + RPC backend support. The resulting image is
# used by BOTH nodes: the "primary" runs `llama-server`, the "worker" runs
# `ggml-rpc-server`. Build this image on each machine (see README.md) so the
# CUDA/driver stack matches that host.

ARG CUDA_VERSION=13.3.1
ARG UBUNTU_VERSION=24.04

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS build

# Broad default covering Pascal through Hopper (GTX 10xx -> H100). Narrow this
# to your exact GPU (e.g. "86" for RTX 30xx, "89" for RTX 40xx) for a faster
# build: `docker compose build --build-arg CUDA_ARCHITECTURES=86`.
ARG CUDA_ARCHITECTURES="60;61;70;75;80;86;89;90"

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Pin to a known-good tag instead of always floating on master.
ARG LLAMA_CPP_REF=master
RUN git clone --depth 1 --branch ${LLAMA_CPP_REF} https://github.com/ggml-org/llama.cpp.git .

# GGML_NATIVE=ON: safe ONLY because this Dockerfile is built independently on
# each machine (`docker compose build` on the primary, again on the worker) -
# "-march=native" always targets the CPU it's about to run on. If you ever
# switch to building once and shipping the image (registry push/pull, docker
# save/load, etc.) to a differing CPU, flip this back to OFF first.
# LLAMA_CURL=OFF: we mount local GGUF files instead of using the -hf downloader,
# which drops the libcurl-dev build dependency entirely.
# CMAKE_EXE_LINKER_FLAGS=--allow-shlib-undefined: ggml-cuda links against the
# CUDA driver API (libcuda.so, for its VMM pool allocator - cuMemCreate etc.),
# but the real libcuda.so.1 only exists on the host and is injected by the
# NVIDIA Container Toolkit at container *run* time, not `docker build` time.
# Without this flag, ld insists on resolving those symbols now and fails; the
# same workaround is used in llama.cpp's own upstream CUDA Dockerfile
# (ggml-org/llama.cpp#13166).
RUN cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_CUDA=ON \
        -DGGML_RPC=ON \
        -DGGML_NATIVE=ON \
        -DLLAMA_CURL=OFF \
        -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined \
        -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}" \
    && cmake --build build --config Release -j"$(nproc)" --target llama-server ggml-rpc-server

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only llama-server and ggml-rpc-server were built as targets, so build/bin/
# just holds those two binaries plus the shared libs they link against
# (libggml*.so, libllama.so, ...) - copy the whole dir rather than globbing.
COPY --from=build /src/build/bin/ /app/bin/

ENV LD_LIBRARY_PATH=/app/bin
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

ENTRYPOINT []
