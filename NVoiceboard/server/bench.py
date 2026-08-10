#!/usr/bin/env python3
"""
Phase 0 calibration for NVoiceboard.

Answers three questions about a given CPU:
  1. RTF  -- can this box keep up with real-time streaming, and at what thread count?
  2. Finalize latency -- mic release to committed text. The number that decides how
     the keyboard *feels*.
  3. Tail correctness -- does the last word survive?

On (3): this export has a 1120 ms chunk baked in (encoder metadata `chunk_shift=112`
frames @ 10 ms). Calling input_finished() does NOT flush the partial trailing chunk,
so up to ~1.1 s of speech is silently dropped. Padding with silence before finalizing
recovers it. This benchmark measures both so the difference is visible rather than
discovered in production.

Usage:  python bench.py [--threads 1,2,4,6,8] [--model ./model]
"""
import argparse
import re
import time
import wave

import numpy as np
import sherpa_onnx

# Silence appended on finalize to flush the trailing chunk. Must exceed the
# encoder's chunk_shift (1120 ms) or the tail is still truncated.
TAIL_PAD_S = 1.2

# From encoder ONNX metadata. sherpa-onnx defaults to 80, which is WRONG for this
# model and produces garbage transcripts rather than an error.
FEAT_DIM = 128


def read_wav(path):
    with wave.open(path) as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path}: need mono 16-bit PCM")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0, w.getframerate()


def build(model_dir, threads):
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=f"{model_dir}/tokens.txt",
        encoder=f"{model_dir}/encoder.int8.onnx",
        decoder=f"{model_dir}/decoder.int8.onnx",
        joiner=f"{model_dir}/joiner.int8.onnx",
        num_threads=threads,
        feature_dim=FEAT_DIM,
        provider="cpu",
    )


def transcribe(rec, samples, sr, pad_s, frame_s=0.05):
    """Feed audio in frame_s chunks like the phone will, then finalize.

    Returns (text, rtf, finalize_ms, partial_gaps).
    """
    stream = rec.create_stream()
    frame = int(frame_s * sr)
    compute = 0.0
    marks, last = [], ""

    for i in range(0, len(samples), frame):
        stream.accept_waveform(sr, samples[i : i + frame])
        t = time.perf_counter()
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        compute += time.perf_counter() - t
        text = rec.get_result(stream)
        if text != last:
            marks.append(min((i + frame) / sr, len(samples) / sr))
            last = text

    t = time.perf_counter()
    if pad_s > 0:
        stream.accept_waveform(sr, np.zeros(int(pad_s * sr), dtype=np.float32))
    stream.input_finished()
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    finalize = time.perf_counter() - t
    compute += finalize

    gaps = [round(b - a, 2) for a, b in zip(marks, marks[1:])]
    dur = len(samples) / sr
    return rec.get_result(stream), compute / dur, finalize * 1000, gaps


def words(s):
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).split()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="model")
    ap.add_argument("--threads", default="1,2,4,6,8")
    ap.add_argument("--wav", default=None, help="your own mono 16k wav")
    args = ap.parse_args()

    refs = {}
    try:
        with open(f"{args.model}/test_wavs/trans.txt") as f:
            for line in f:
                name, _, text = line.strip().partition(" ")
                refs[name] = text
    except FileNotFoundError:
        pass

    clips = [args.wav] if args.wav else [
        f"{args.model}/test_wavs/0.wav",
        f"{args.model}/test_wavs/1.wav",
    ]

    print(f"tail pad: {TAIL_PAD_S}s   feat_dim: {FEAT_DIM}\n")
    print(f"{'threads':>7} {'clip':>10} {'RTF':>7} {'finalize':>10} {'partial gap':>12}")
    print("-" * 52)

    best = None
    for threads in [int(t) for t in args.threads.split(",")]:
        t0 = time.perf_counter()
        rec = build(args.model, threads)
        load = time.perf_counter() - t0
        for path in clips:
            samples, sr = read_wav(path)
            text, rtf, fin_ms, gaps = transcribe(rec, samples, sr, TAIL_PAD_S)
            gap = f"{np.mean(gaps):.2f}s" if gaps else "n/a"
            name = path.rsplit("/", 1)[-1]
            print(f"{threads:>7} {name:>10} {rtf:>7.3f} {fin_ms:>8.1f}ms {gap:>12}")
            if best is None or rtf < best[1]:
                best = (threads, rtf)
        print(f"{'':>7} {'(load ' + f'{load:.2f}s)':>10}")

    # Tail-drop demonstration. This is the finding most likely to bite later.
    print("\n=== tail padding ===")
    rec = build(args.model, best[0])
    for path in clips:
        samples, sr = read_wav(path)
        name = path.rsplit("/", 1)[-1]
        without, _, _, _ = transcribe(rec, samples, sr, 0.0)
        with_pad, _, fin_ms, _ = transcribe(rec, samples, sr, TAIL_PAD_S)
        print(f"\n{name}")
        print(f"  no pad     : ...{' '.join(words(without)[-8:])}")
        print(f"  +{TAIL_PAD_S}s pad ({fin_ms:.0f}ms): ...{' '.join(words(with_pad)[-8:])}")
        if name in refs:
            ref = words(refs[name])
            print(f"  reference  : ...{' '.join(ref[-8:])}")
            for label, hyp in (("no pad", without), ("padded", with_pad)):
                h = words(hyp)
                miss = len(ref) - len(h)
                flag = "OK" if h[-3:] == ref[-3:] else f"TRUNCATED (-{miss} words)"
                print(f"    {label:>7}: {flag}")

    print(f"\nbest thread count: {best[0]} (RTF {best[1]:.3f})")
    print("RTF must stay well under 1.0; anything under ~0.5 has comfortable headroom.")


if __name__ == "__main__":
    main()
