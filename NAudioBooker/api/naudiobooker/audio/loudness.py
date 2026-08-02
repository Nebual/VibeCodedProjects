"""Loudness measurement and gain calculation.

Targets the ACX audiobook window, which is the closest thing to a standard for
spoken-word audio: RMS between -23 and -18 dBFS, true peak no higher than
-3 dBFS. Even outside ACX submission it is a sensible target -- it is quiet
enough to leave headroom and loud enough not to disappear in a car.

RMS rather than LUFS deliberately. LUFS (EBU R128) is the broadcast standard
and ffmpeg's ``loudnorm`` implements it, but the audiobook world specifies RMS,
and mixing the two produces output that satisfies neither.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

#: Middle of the ACX window, so small per-chapter variation stays inside it.
TARGET_RMS_DBFS = -20.0
MAX_PEAK_DBFS = -3.0

#: Blocks used for streaming measurement. A chapter can be hours long, so it is
#: never held in memory whole.
_BLOCK_FRAMES = 1 << 20

_SILENCE_FLOOR_DBFS = -120.0


def _to_dbfs(amplitude: float) -> float:
    if amplitude <= 0:
        return _SILENCE_FLOOR_DBFS
    return 20.0 * math.log10(amplitude)


@dataclass(frozen=True)
class Loudness:
    rms_dbfs: float
    peak_dbfs: float
    frames: int

    @property
    def is_silent(self) -> bool:
        return self.peak_dbfs <= _SILENCE_FLOOR_DBFS


def measure(path: Path) -> Loudness:
    """Measure RMS and peak over a whole file without loading it."""
    total_square = 0.0
    frames = 0
    peak = 0.0

    with sf.SoundFile(path) as audio:
        while True:
            block = audio.read(_BLOCK_FRAMES, dtype="float32")
            if not len(block):
                break
            if block.ndim > 1:
                block = block.mean(axis=1)
            total_square += float(np.sum(np.square(block, dtype=np.float64)))
            peak = max(peak, float(np.max(np.abs(block))))
            frames += len(block)

    rms = math.sqrt(total_square / frames) if frames else 0.0
    return Loudness(rms_dbfs=_to_dbfs(rms), peak_dbfs=_to_dbfs(peak), frames=frames)


def combine(parts: list[Loudness]) -> Loudness:
    """One measurement covering several files, as if they were concatenated.

    Used to give a whole book a single gain instead of one per chapter.
    Measured on Kokoro, five very different passages in one voice span 0.4 dB
    of RMS -- inaudible -- so a per-chapter correction is chasing noise. Worse,
    it is the wrong shape: normalising each chapter separately would flatten
    genuine differences between them, quietly boosting a subdued chapter to
    match a loud one.

    RMS is pooled over frames rather than averaged over files, so a
    ninety-second foreword cannot pull the level of a nine-hour book around.
    """
    real = [p for p in parts if p.frames > 0]
    if not real:
        return Loudness(rms_dbfs=_SILENCE_FLOOR_DBFS, peak_dbfs=_SILENCE_FLOOR_DBFS, frames=0)

    frames = sum(p.frames for p in real)
    # Back out each part's mean square from its dBFS, weight by length, repool.
    total_square = sum((10.0 ** (p.rms_dbfs / 20.0)) ** 2 * p.frames for p in real)
    return Loudness(
        rms_dbfs=_to_dbfs(math.sqrt(total_square / frames)),
        peak_dbfs=max(p.peak_dbfs for p in real),
        frames=frames,
    )


#: Ceiling on how much work the limiter is asked to do. Speech tolerates a few
#: dB of peak reduction without sounding processed; much more and it audibly
#: flattens. Past this, loudness is sacrificed instead.
MAX_LIMITING_DB = 8.0


def to_linear(dbfs: float) -> float:
    return 10.0 ** (dbfs / 20.0)


@dataclass(frozen=True)
class GainPlan:
    """How to get a chapter into the target window."""

    gain_db: float
    #: Ceiling the limiter enforces after the gain is applied.
    limit_dbfs: float
    #: How far the limiter will have to pull peaks down. Diagnostic only.
    limiting_db: float

    @property
    def limit_linear(self) -> float:
        return to_linear(self.limit_dbfs)


def plan_gain(
    loudness: Loudness,
    *,
    target_rms_dbfs: float = TARGET_RMS_DBFS,
    max_peak_dbfs: float = MAX_PEAK_DBFS,
    max_limiting_db: float = MAX_LIMITING_DB,
) -> GainPlan:
    """Plan gain plus limiting to reach the target RMS under a peak ceiling.

    Gain alone cannot do this for speech. Synthesized narration measures around
    18 dB of crest factor per chunk and more across a whole chapter, once the
    silence between chunks drags the average down while the peak stays put. A
    -3 dBFS ceiling therefore caps the achievable RMS near -26 dBFS, three
    below the bottom of the ACX window -- which is exactly what the first
    version of this code produced.

    Real audiobook mastering solves it with a limiter, so this does too: gain
    for the RMS target, then let a lookahead limiter hold the peaks. When that
    would demand more than ``max_limiting_db`` of reduction the gain is backed
    off instead, because audibly squashed narration is worse than quiet
    narration.
    """
    if loudness.is_silent or loudness.frames == 0:
        return GainPlan(gain_db=0.0, limit_dbfs=max_peak_dbfs, limiting_db=0.0)

    wanted = target_rms_dbfs - loudness.rms_dbfs
    overshoot = (loudness.peak_dbfs + wanted) - max_peak_dbfs

    if overshoot > max_limiting_db:
        wanted -= overshoot - max_limiting_db
        overshoot = max_limiting_db

    return GainPlan(
        gain_db=wanted,
        limit_dbfs=max_peak_dbfs,
        limiting_db=max(overshoot, 0.0),
    )
