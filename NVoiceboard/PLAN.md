# NVoiceboard

Android voice-input IME backed by a LAN speech-to-text server.

## Shape

A **standalone voice IME** — not a HeliBoard fork. HeliBoard has no voice input of its
own; its mic key switches to whichever IME registers a `voice` subtype. So NVoiceboard
registers that subtype, HeliBoard hands off to it, and HeliBoard stays stock from F-Droid.
This also works with FlorisBoard and AnySoftKeyboard for free.

Revisit forking later, only if the IME-switch flicker proves annoying enough to matter.

```
[HeliBoard] --mic key--> [NVoiceboard IME] --wss--> [stt.nebtown.info]
     ^                          |                    Nemotron streaming 0.6B
     |                          |                    sherpa-onnx / ONNX Runtime
     +----commitText() + switchToPreviousInputMethod()
```

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Integration | Standalone voice IME | No fork maintenance, no GPL-3.0 inheritance, works with 3 keyboards |
| Transcription | Live partials while speaking | Chosen UX; forces a streaming model |
| Model | `nemotron-speech-streaming-en-0.6b` | Cache-aware, native punctuation+caps, tunable chunk size |
| Runtime | sherpa-onnx (CPU) | Has Nemotron support + a ready streaming WS server |
| Compute | CPU only (Ryzen 7 1800X, 32 GB, Debian 12) | See "RX 470" below |
| Reach | Public — `stt.nebtown.info`, 443 forwarded to the host | Works away from home; costs a real threat model |
| Transport | WebSocket, raw PCM | 32 KB/s — compression buys little, costs latency |
| Discovery | Hardcoded hostname | Public A record; split-horizon locally to dodge NAT hairpin |
| Deployment | Docker STT container behind the host's existing nginx | Reuses existing TLS setup |
| Language | English only | Uses the EN model, not the 40-language multilingual one |

### The RX 470 is not used

Live partials require a streaming model, which forecloses every Polaris path:

- ONNX Runtime has no working Polaris EP on Linux (ROCm EP won't target gfx803;
  DirectML is Windows-only).
- ggml/Vulkan — the one clean Polaris route — runs Whisper, which is batch-only.
- NeMo-native would need PyTorch on gfx803, i.e. community Docker images on pinned
  old stacks.

Not a problem in practice: a cache-aware streaming encoder processes ~0.5s of audio at
a time, and these models were designed to run real-time on CPU. The only way to put the
GPU back to work is batch Whisper on Vulkan, which costs the partials.

## Model

[`nvidia/nemotron-speech-streaming-en-0.6b`](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)

- **Cache-aware FastConformer-RNNT** — no recomputation of overlapping windows, and
  partials are stable (words don't thrash as later context arrives). Matters a lot when
  the text is visible while you speak.
- **Native punctuation and capitalization** — no separate punctuation model in the path.
- **Chunk sizes 80 / 160 / 320 / 560 / 1120 ms**, ~7.2–7.8% WER across the range — but
  **fixed at export time, not runtime-tunable.** Both published sherpa-onnx exports use
  1120 ms. Changing it means re-exporting from NeMo. (Phase 0 finding.)
- **Pre-exported for sherpa-onnx by its maintainer** — no export pipeline needed:
  [fp32](https://huggingface.co/csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-2026-01-14)
  and [int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14).
  Both dated 2026-01-14; NVIDIA shipped an updated checkpoint 2026-03-12, so check for a
  newer dated export before downloading.
- Transducer, so it does **not** hallucinate on silence the way Whisper does
  (the "Thank you for watching!" failure mode). Critical for a keyboard, which types
  its output into someone's message box.

Fallback if too slow: streaming Zipformer + `sherpa-onnx-online-punct-en-2024-08-06`.
Worse WER, runs on anything. Dropped from the plan unless Phase 0 forces it.

## Latency

Chunk size dominates everything else.

**Superseded by Phase 0 measurement.** The chunk size is not a runtime dial — it's baked
into the ONNX export, and both published exports use **1120 ms**. See `server/README.md`.

| | measured |
|---|---|
| Chunk accumulation | 1120 ms (fixed by export) |
| Round trip (home WiFi) | ~5 ms |
| Round trip (cellular) | 30–60 ms |
| Finalize compute (1800X, est.) | ~150–250 ms |
| **Partial cadence** | **~1.12 s bursts** |
| **Release → committed text** | **~200–320 ms** |

The keyboard's *feel* is dominated by release-to-text, which is fine. What suffers is
partial smoothness: text arrives in ~1.1 s lumps rather than flowing. Acceptable, but
noticeably behind Gboard. Smaller chunks require exporting from NeMo ourselves.

Two things will inject spikes that dwarf any model tuning:

- **WiFi power-save** — 100–300 ms stalls. Hold `WifiLock(WIFI_MODE_FULL_LOW_LATENCY)`
  while recording.
- **TLS handshake on mic-tap** — 3+ RTTs. Pre-open the socket in `onStartInputView()`.

Send audio in small frames (~50 ms) regardless of model chunk size; let the server
accumulate. Decouples network granularity from model granularity and spreads jitter.

## Protocol

WebSocket. Binary frames carry raw PCM s16le / 16 kHz / mono. Text frames carry JSON.

```
client → {"type":"start","sample_rate":16000}
client → <binary PCM, ~50ms per frame>
server → {"type":"partial","text":"hey can you pick up"}
server → {"type":"partial","text":"hey can you pick up milk"}
client → {"type":"eos"}                    // mic released
server → {"type":"final","text":"Hey, can you pick up milk?"}
```

## Android notes

- `AudioRecord` with `AudioSource.VOICE_RECOGNITION` — bypasses AGC/noise suppression
  that ASR models don't want, and it's lower latency than `MIC`.
- `RECORD_AUDIO` **cannot** be requested from an `InputMethodService` — a `Service` can't
  call `requestPermissions()`. Needs a transparent Activity. Every app in this space
  does this dance.
- Render partials in the IME's own panel, not via `setComposingText()`. Composing text
  gives a better "words appear where I'm typing" feel but browsers and some editors
  mishandle it. Try it as a later refinement.
- On finalize: `commitText()`, then `switchToPreviousInputMethod()` to hand back.
- Never stream from `TYPE_TEXT_VARIATION_PASSWORD` fields.
- Bearer token in the WebSocket upgrade header. OkHttp can set handshake headers
  (browsers can't — irrelevant here).
- Ordinary DNS is fine now that the record is public; no custom OkHttp `Dns` needed.

## Server

### Threat model

The service is internet-facing, so:

- **Auth is deferred to Phase 3** by decision. Until then anyone who finds the endpoint
  can burn all 8 cores by streaming audio at it. Cheap stopgap: serve from an unguessable
  `location` prefix, which costs one nginx line.
- **Never expose sherpa-onnx's bundled server directly.** It's a research/demo daemon
  with no auth and no rate limiting; it was not written to face the internet.
- **NAT hairpin.** On home WiFi the phone resolves to the public IP and packets must
  loop back through the router. Many consumer routers do this, some don't, some add
  latency. Fix with split-horizon DNS — serve the LAN IP for that hostname locally.
  The Let's Encrypt cert still validates, since the hostname is unchanged.
- Microphone audio now crosses the internet. TLS covers it in transit.

Tailscale would give the same "works anywhere" reach with no public attack surface, no
auth to build, and no hairpin problem — strictly less work for a single-user service.
Rejected in favour of port forwarding; revisit if hardening becomes a chore.

### Deployment

TLS terminates on the host's **existing nginx**, which reverse-proxies to a single Docker
container on loopback:

- **STT container** — `python:3.12-slim`, `pip install sherpa-onnx websockets`, running
  our own server (~150 lines) implementing the protocol above. Using the Python bindings
  rather than sherpa-onnx's bundled C++ server means we get our protocol exactly, instead
  of conforming to theirs. Phase 0 can still use the bundled server for measurement —
  it's throwaway.

Publish the port as **`127.0.0.1:8192:8192`**, never `8192:8192`. Docker writes its own
iptables rules that bypass UFW, so the bare form would expose the unauthenticated ASR
server directly on the public IP with nginx not even in the path.

### nginx

```nginx
# MUST be in http{} context — not inside server{}, nginx won't start.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name stt.nebtown.info;

    include snippets/ssl-stt.nebtown.info.conf;   # must match this hostname
    include snippets/ssl-params.conf;

    location / {
        proxy_pass http://127.0.0.1:8192;
        proxy_http_version 1.1;                    # required for WebSocket

        proxy_set_header Host              $host;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

        proxy_buffering       off;
        tcp_nodelay           on;
        proxy_connect_timeout 5s;
        proxy_read_timeout    600s;                # survive idle pre-warmed sockets
        proxy_send_timeout    600s;
    }
}
```

Three things that will bite:

- **`proxy_http_version 1.1` is mandatory.** nginx proxies with HTTP/1.0 by default and
  the WebSocket upgrade handshake requires 1.1. Omitting it fails the upgrade outright.
- **Cert hostname must match.** A snippet named for a different host only works if it's
  a `*.nebtown.info` wildcard.
- **`proxy_read_timeout` defaults to 60s**, which kills pre-warmed idle sockets. Raise it
  and send app-level WebSocket pings (~30s).

`http2` on the listener is harmless: nginx can't proxy WebSockets over h2 (no RFC 8441),
but OkHttp forces HTTP/1.1 for WebSocket connections, so ALPN sorts it out.

On stock Debian 12 (nginx 1.22.1) `listen 443 ssl http2;` is correct. Mainline 1.25.1+
deprecates it in favour of `listen 443 ssl;` plus `http2 on;`.

### Operational

- Model warm in RAM at all times (cold start is seconds). Container restart policy
  `unless-stopped`.
- Rate limiting in Caddy needs a plugin and an `xcaddy` custom build — simpler to cap
  concurrent connections and per-token audio-seconds inside the Python server.
- Tune ONNX Runtime thread count: test 4 / 6 / 8. It often regresses past ~8 threads
  on this workload — don't assume all 16 hardware threads help. Zen 1 runs AVX2 at half
  rate and has no VNNI, so int8 won't accelerate the way it would on Zen 3+.

## Phases

**Phase 0 — spike. DONE (harness in `server/`, pending confirmation on the 1800X).**
Verified the model runs, measured RTF and finalize latency, swept thread count, and found
two constraints that shape everything downstream — the fixed 1120 ms chunk and the
dropped-tail bug. Details in `server/README.md`. Remaining: run `docker compose run --rm
bench` on the actual box and confirm Zen 1 numbers.

**Phase 1 — server for real.** Python STT container implementing our protocol, published
on `127.0.0.1:8192`, nginx vhost in front. Port forward 443. Verify over cellular, and
verify the hairpin case from home WiFi. No auth yet.

**Phase 2 — minimal IME.** Voice subtype registration, `AudioRecord` capture, WebSocket
client, partials in panel, `commitText()` on release, hand back to HeliBoard.

**Phase 3 — hardening.** Bearer-token auth, connection and audio-second caps, per-IP
rate limiting. Reconnect/backoff, password-field guard, WifiLock, offline error state,
socket pre-warm, WS keepalive pings.

**Phase 4 — optional.** `RecognitionService` registration so non-keyboard apps can call
it, voice commands ("new line", "scratch that"), on-device fallback for no-signal.

## Open questions

- **Is the 1.12 s partial cadence acceptable, or do we re-export from NeMo for a smaller
  chunk?** The biggest open question. Re-export needs the NeMo/PyTorch toolchain and an
  understanding of `att_context_size`; it's a one-time CPU job but not trivial.
- Is there a sherpa-onnx export of the 2026-03-12 checkpoint yet? Only 2026-01-14 exists
  as of now, and it predates NVIDIA's larger-corpus retrain.
- Does the fp32 export have the same 1120 ms chunk? Almost certainly (same author, same
  date) but unverified — worth 2 minutes before committing to a re-export.
- Does the router hairpin? Determines whether split-horizon DNS is required or merely
  nice.
- Long dictation: cap utterance length, or chunk and re-anchor?
- Token rotation — hardcode one in the APK, or a pairing flow?
