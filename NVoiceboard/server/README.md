# Phase 0 — calibration

Run on the Debian 12 box (Ryzen 7 1800X). Nothing here touches the network.

```bash
./download-model.sh          # ~632 MB into ./model/
docker compose build
docker compose run --rm bench
```

Optionally benchmark your own voice — the test WAVs are clean LibriSpeech read speech
and will flatter the model relative to a phone mic in a room:

```bash
docker compose run --rm bench python bench.py --model /app/model --wav /app/model/mine.wav
```

(mono, 16 kHz, 16-bit PCM)

## What to look for

- **RTF** — must stay well under 1.0. Under ~0.5 is comfortable.
- **best thread count** — expect it to plateau around 4 and regress by 8. Don't assume
  all 16 hardware threads help.
- **tail padding** — the `no pad` rows should read `TRUNCATED`, the `padded` rows `OK`.
  If not, the assumption below has changed and the server code needs revisiting.

## Reference numbers

Measured on a Ryzen 7 9800X3D (Zen 5), int8 model, 50 ms input frames:

| threads | RTF | finalize |
|---|---|---|
| 1 | 0.10 | 113 ms |
| 2 | 0.06 | 68 ms |
| **4** | **0.047** | **56 ms** |
| 6 | 0.048 | 55 ms |
| 8 | 0.053–0.063 | 56–71 ms |

The 1800X is Zen 1 — half-rate AVX2, no VNNI — so expect roughly 3–5× these figures.
Predicted RTF ~0.15–0.25 and finalize ~150–250 ms at 4 threads. Both fine. **Confirm
rather than trust; that multiplier is an estimate, not a measurement.**

## Two findings that constrain the design

### The 1120 ms chunk is baked into the export

Encoder ONNX metadata says `chunk_shift = 112` frames at 10 ms. The model *architecture*
supports 80/160/320/560/1120 ms, but each ONNX export fixes one, and the only two
published sherpa-onnx exports (fp32 and int8, both 2026-01-14) use the slowest.

Consequence: partials arrive in ~1.12 s bursts, not smoothly. Measured `partial gap` is
1.12 s regardless of thread count — it's a property of the export, not the CPU.

Getting a smaller chunk means exporting from NeMo yourself with a different
`att_context_size`. One-time CPU job, but it needs the NeMo/PyTorch toolchain.

### Trailing audio is dropped unless you pad

`input_finished()` does **not** flush the partial trailing chunk. Up to ~1.1 s of speech
is silently discarded — measured as 1–2 lost words on the test clips, at the end of the
utterance, with no error. For a keyboard this reads as "it always eats my last word."

Fix: append `TAIL_PAD_S = 1.2` seconds of silence before `input_finished()`. Costs one
extra chunk of compute (~55 ms here, likely ~200 ms on the 1800X) and recovers the tail
exactly. Verified against the reference transcripts.

### Also worth knowing

`feature_dim=128` must be passed explicitly. sherpa-onnx defaults to 80, and the
mismatch produces plausible-looking garbage rather than an error.
