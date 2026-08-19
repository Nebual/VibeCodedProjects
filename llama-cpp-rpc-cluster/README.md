# llama.cpp distributed inference (2 nodes, CUDA + RPC)

Splits a model across two GPU machines using llama.cpp's `ggml-rpc` backend:

- **Worker** (`192.168.0.162`) runs `ggml-rpc-server`, exposing its GPU over the network.
- **Primary** (this machine, or whichever box you want serving requests) runs `llama-server`,
  offloading some layers to its own GPU and the rest to the worker over RPC, and exposes the
  OpenAI-compatible HTTP API to the LAN.

## Prerequisites (on BOTH machines)

- NVIDIA driver installed on the host, new enough for CUDA 13.3 (driver >=610.43.02 - check with
  `nvidia-smi`, the `CUDA Version:` in the header is the max your driver supports, not what's
  installed). If either machine reports less than that, lower `CUDA_VERSION` in the Dockerfile to
  `12.9.2` instead (see the note below).
- Docker + Docker Compose v2
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed and configured (`nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`)
- Verify GPU passthrough works before touching llama.cpp:
  ```bash
  docker run --rm --gpus all nvidia/cuda:13.3.1-base-ubuntu24.04 nvidia-smi
  ```

Copy this whole `llama-cpp-rpc-cluster/` folder to both machines (git clone, scp, whatever) - each
machine builds its own image locally so the CUDA/driver stack matches that host.

## 1. Worker node (192.168.0.162)

```bash
cp .env.example .env
# edit .env: set CUDA_ARCHITECTURES to your GPU, leave RPC_PORT=50052 unless you have a reason to change it
docker compose -f docker-compose.worker.yml up -d --build
docker compose -f docker-compose.worker.yml logs -f   # confirm it started and detected the GPU
```

**Lock the RPC port down to just the primary node** - the protocol has no auth or encryption, and
upstream explicitly warns it must never be reachable from an open network:

```bash
sudo ufw allow from <PRIMARY_NODE_IP> to any port 50052 proto tcp
sudo ufw deny 50052/tcp
```

## 2. Primary node

```bash
cp .env.example .env
# edit .env:
#   MODEL_FILE=<name of your .gguf file>
#   RPC_HOSTS=192.168.0.162:50052   (already the default)
#   CUDA_ARCHITECTURES=<your GPU>
```

Put your GGUF model in `./models/` (or point `MODELS_DIR` at wherever it already lives).

```bash
docker compose up -d --build
docker compose logs -f
```

Once it's up, the API is reachable from anywhere on the LAN:

```bash
curl http://<PRIMARY_NODE_IP>:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local", "messages": [{"role": "user", "content": "hello"}]}'
```

## Notes

- **Multiple workers**: add more `host:port` entries to `RPC_HOSTS`, comma-separated
  (`192.168.0.162:50052,192.168.0.163:50052`), and run `docker-compose.worker.yml` on each.
- **Layer distribution**: `llama-server` splits layers across all devices (local GPU + every RPC
  worker) proportionally to free memory by default. Add `--tensor-split` to the `command:` list in
  `docker-compose.yml` to control this manually.
- **`llama.cpp` version drift**: the Dockerfile clones `master` by default (`LLAMA_CPP_REF` build
  arg). Pin it to a tagged release (e.g. `b4700`) for a build that won't change under you.
- **CUDA/Ubuntu version**: defaults are CUDA 13.3.1 on Ubuntu 24.04, confirmed against a driver
  reporting 610.43.02 (the 13.3 minimum) on the primary - re-check `nvidia-smi` on the worker too if
  its driver might differ. If a machine ever reports a driver below 610.43, drop `CUDA_VERSION` in
  the Dockerfile to `12.9.2` (needs a much older driver, still fully supports arch 86). Ubuntu 26.04
  images also exist but are brand new (April 2026) with less-tested container tooling; the Ubuntu
  version doesn't affect driver compatibility since the driver lives on the host, not in the image.
