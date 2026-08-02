"""One gain for the whole book, and no gratuitous resampling.

Both were measured rather than assumed: five very different Kokoro passages in
one voice span 0.4 dB of RMS, and the unconditional 44.1 kHz upsample cost
about 30% of the M4B encode while adding no information.
"""

from __future__ import annotations

import math
import subprocess

import numpy as np
import pytest
import soundfile as sf

from naudiobooker.audio import combine, measure, plan_gain
from naudiobooker.audio.loudness import Loudness
from naudiobooker.audio.m4b import M4BChapter, _common_rate, build_m4b


def tone(path, seconds=1.0, rate=24_000, amplitude=0.2):
    t = np.arange(int(seconds * rate), dtype=np.float32) / rate
    sf.write(path, (np.sin(2 * np.pi * 220 * t) * amplitude).astype(np.float32), rate)
    return path


# ---------------------------------------------------------------------------
# Pooling several chapters into one measurement
# ---------------------------------------------------------------------------


def test_combining_one_measurement_changes_nothing() -> None:
    only = Loudness(rms_dbfs=-20.0, peak_dbfs=-3.0, frames=1000)

    assert combine([only]) == only


def test_rms_is_pooled_by_length_not_averaged(tmp_path) -> None:
    """A ninety-second foreword must not drag a nine-hour book's level about."""
    loud = Loudness(rms_dbfs=-10.0, peak_dbfs=-1.0, frames=100)
    quiet = Loudness(rms_dbfs=-30.0, peak_dbfs=-9.0, frames=99_900)

    pooled = combine([loud, quiet])

    naive_mean = (-10.0 + -30.0) / 2
    assert pooled.rms_dbfs < naive_mean, "the short loud part dominated"
    assert pooled.rms_dbfs == pytest.approx(-29.59, abs=0.05)
    assert pooled.frames == 100_000


def test_peak_is_the_loudest_anywhere() -> None:
    pooled = combine(
        [
            Loudness(rms_dbfs=-20.0, peak_dbfs=-9.0, frames=10),
            Loudness(rms_dbfs=-20.0, peak_dbfs=-0.5, frames=10),
        ]
    )

    assert pooled.peak_dbfs == -0.5


def test_pooled_rms_matches_measuring_the_concatenation(tmp_path) -> None:
    """The whole point: combine() must equal measuring the joined audio."""
    rate = 24_000
    rng = np.random.default_rng(7)
    parts, whole = [], []
    for i, amp in enumerate((0.05, 0.4, 0.15)):
        samples = (rng.standard_normal(rate * (i + 1)) * amp).astype(np.float32)
        path = tmp_path / f"p{i}.wav"
        sf.write(path, samples, rate)
        parts.append(measure(path))
        whole.append(samples)

    joined = tmp_path / "joined.wav"
    sf.write(joined, np.concatenate(whole), rate)

    assert combine(parts).rms_dbfs == pytest.approx(measure(joined).rms_dbfs, abs=0.01)
    assert combine(parts).peak_dbfs == pytest.approx(measure(joined).peak_dbfs, abs=0.01)


def test_silent_chapters_do_not_poison_the_book(tmp_path) -> None:
    empty = Loudness(rms_dbfs=-120.0, peak_dbfs=-120.0, frames=0)
    real = Loudness(rms_dbfs=-20.0, peak_dbfs=-3.0, frames=1000)

    assert combine([empty, real]).rms_dbfs == pytest.approx(-20.0, abs=0.01)
    assert combine([]).frames == 0


def test_one_book_wide_plan_lands_in_the_acx_window(tmp_path) -> None:
    """Kokoro's real level: -20.7 dBFS RMS, peaks up to -0.3."""
    plan = plan_gain(Loudness(rms_dbfs=-20.7, peak_dbfs=-0.3, frames=10**7))

    assert abs(plan.gain_db) < 1.5, "already mid-window; gain should be near zero"
    assert plan.limit_dbfs is not None, "peaks above -3 dBFS need the limiter"


# ---------------------------------------------------------------------------
# Resampling only when it is needed
# ---------------------------------------------------------------------------


def test_matching_rates_need_no_resample(tmp_path) -> None:
    chapters = [
        M4BChapter("A", tone(tmp_path / "a.wav", rate=24_000), 1.0),
        M4BChapter("B", tone(tmp_path / "b.wav", rate=24_000), 1.0),
    ]

    assert _common_rate(chapters) is None


def test_mismatched_rates_are_reconciled_upward(tmp_path) -> None:
    """A job that fell back between backends must still build, not error."""
    chapters = [
        M4BChapter("A", tone(tmp_path / "a.wav", rate=24_000), 1.0),
        M4BChapter("B", tone(tmp_path / "b.wav", rate=44_100), 1.0),
    ]

    assert _common_rate(chapters) == 44_100


def test_an_unreadable_header_falls_back_rather_than_gambling(tmp_path) -> None:
    missing = tmp_path / "gone.wav"
    chapters = [M4BChapter("A", missing, 1.0)]

    assert _common_rate(chapters) == 44_100


@pytest.mark.skipif(
    subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0,
    reason="ffmpeg not installed",
)
def test_the_m4b_keeps_the_source_rate(tmp_path) -> None:
    chapters = [
        M4BChapter("One", tone(tmp_path / "a.wav", seconds=1.5, rate=24_000), 1.5),
        M4BChapter("Two", tone(tmp_path / "b.wav", seconds=1.0, rate=24_000), 1.0),
    ]
    out = tmp_path / "book.m4b"

    build_m4b(chapters, out, title="A Book", artist="An Author", work_dir=tmp_path)

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "csv=p=0",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert probe.startswith("24000"), f"expected 24 kHz, got {probe!r}"


@pytest.mark.skipif(
    subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0,
    reason="ffmpeg not installed",
)
def test_an_explicit_rate_is_honoured(tmp_path) -> None:
    chapters = [M4BChapter("One", tone(tmp_path / "a.wav", seconds=1.0, rate=24_000), 1.0)]
    out = tmp_path / "book.m4b"

    build_m4b(chapters, out, title="B", artist="A", work_dir=tmp_path, sample_rate=44_100)

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate",
            "-of",
            "csv=p=0",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert probe == "44100"


@pytest.mark.skipif(
    subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0,
    reason="ffmpeg not installed",
)
def test_gain_reaches_the_m4b(tmp_path) -> None:
    """The gain moved from per-input to a single post-concat filter; it must
    still actually be applied."""
    quiet = tone(tmp_path / "a.wav", seconds=2.0, rate=24_000, amplitude=0.05)
    chapters = [M4BChapter("One", quiet, 2.0)]

    plain = tmp_path / "plain.m4b"
    boosted = tmp_path / "boosted.m4b"
    build_m4b(chapters, plain, title="B", artist="A", work_dir=tmp_path)
    build_m4b(chapters, boosted, title="B", artist="A", work_dir=tmp_path, gain_db=12.0)

    def rms(path):
        out = subprocess.run(
            # volumedetect reports at info level, which -v error swallows.
            [
                "ffmpeg",
                "-hide_banner",
                "-nostats",
                "-v",
                "info",
                "-i",
                str(path),
                "-af",
                "volumedetect",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        ).stderr
        for line in out.splitlines():
            if "mean_volume" in line:
                return float(line.split(":")[1].strip().split()[0])
        raise AssertionError(f"no mean_volume in {out!r}")

    assert rms(boosted) > rms(plain) + 10.0, "the gain never made it into the file"
    assert math.isclose(rms(boosted), rms(plain) + 12.0, abs_tol=1.5)
