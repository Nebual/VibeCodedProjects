"""Loudness maths, tagging, and the M4B chapter metadata format."""

from __future__ import annotations

import math
import shutil

import numpy as np
import pytest
import soundfile as sf
from mutagen.id3 import ID3

from naudiobooker.audio import (
    Loudness,
    M4BChapter,
    TrackTags,
    loudness_filter,
    measure,
    plan_gain,
    probe_duration,
    tag_mp3,
    wav_to_mp3,
)
from naudiobooker.audio.loudness import (
    MAX_LIMITING_DB,
    MAX_PEAK_DBFS,
    TARGET_RMS_DBFS,
)
from naudiobooker.audio.m4b import build_metadata

HAS_FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")


def tone(path, *, amplitude=0.5, seconds=1.0, rate=24_000):
    t = np.arange(int(rate * seconds), dtype=np.float32) / rate
    sf.write(path, (np.sin(2 * np.pi * 220 * t) * amplitude).astype(np.float32), rate)
    return path


# ---------------------------------------------------------------------------
# Loudness
# ---------------------------------------------------------------------------


def test_measures_rms_and_peak_of_a_sine(tmp_path):
    # A sine of amplitude a has RMS a/sqrt(2).
    result = measure(tone(tmp_path / "t.wav", amplitude=0.5))

    assert result.peak_dbfs == pytest.approx(20 * math.log10(0.5), abs=0.1)
    assert result.rms_dbfs == pytest.approx(20 * math.log10(0.5 / math.sqrt(2)), abs=0.1)
    assert result.frames == 24_000


def test_silence_is_reported_as_silent(tmp_path):
    path = tmp_path / "s.wav"
    sf.write(path, np.zeros(2400, dtype=np.float32), 24_000)

    assert measure(path).is_silent


def test_quiet_audio_is_brought_up_to_target():
    quiet = Loudness(rms_dbfs=-32.0, peak_dbfs=-25.0, frames=1000)

    plan = plan_gain(quiet)

    assert plan.gain_db == pytest.approx(TARGET_RMS_DBFS - (-32.0))
    assert plan.limiting_db == 0.0  # peak stays under the ceiling unaided


def test_loud_audio_is_brought_down():
    loud = Loudness(rms_dbfs=-10.0, peak_dbfs=-1.0, frames=1000)

    assert plan_gain(loud).gain_db < 0


def test_high_crest_audio_reaches_the_target_via_limiting():
    """Speech has ~20 dB of crest; gain alone cannot hit the RMS target.

    This is the case the first implementation got wrong. It clamped gain to
    protect the peak and produced output three decibels below the ACX window.
    """
    speechlike = Loudness(rms_dbfs=-26.0, peak_dbfs=-4.0, frames=1000)

    plan = plan_gain(speechlike)

    # Full gain for the RMS target...
    assert plan.gain_db == pytest.approx(TARGET_RMS_DBFS - (-26.0))
    assert speechlike.rms_dbfs + plan.gain_db == pytest.approx(TARGET_RMS_DBFS)
    # ...with the limiter catching the peaks that would otherwise overshoot.
    assert plan.limiting_db == pytest.approx((-4.0 + plan.gain_db) - MAX_PEAK_DBFS)
    assert plan.limit_dbfs == MAX_PEAK_DBFS


def test_gain_is_backed_off_rather_than_over_limiting():
    """Beyond the limiting budget, prefer quiet narration to squashed narration."""
    very_spiky = Loudness(rms_dbfs=-40.0, peak_dbfs=-1.0, frames=1000)

    plan = plan_gain(very_spiky)

    assert plan.limiting_db == pytest.approx(MAX_LIMITING_DB)
    assert very_spiky.rms_dbfs + plan.gain_db < TARGET_RMS_DBFS


def test_silent_audio_gets_no_gain():
    plan = plan_gain(Loudness(rms_dbfs=-200.0, peak_dbfs=-200.0, frames=100))

    assert plan.gain_db == 0.0
    assert plan.limiting_db == 0.0


def speech_like(path, *, rate=24_000, seconds=4.0):
    """A signal with speech's crest factor: loud bursts separated by near-silence.

    A pure sine has about 3 dB of crest and sails through normalisation, which
    is precisely why testing with one hid the bug this replaces.
    """
    n = int(rate * seconds)
    t = np.arange(n, dtype=np.float32) / rate
    carrier = np.sin(2 * np.pi * 180 * t).astype(np.float32)
    # ~4% duty cycle, giving roughly 16 dB of crest -- in the region real
    # narration occupies, where the RMS target and the peak ceiling conflict.
    envelope = (np.sin(2 * np.pi * 3.0 * t) > 0.98).astype(np.float32)
    signal = carrier * envelope * 0.9
    sf.write(path, signal, rate)
    return path


@needs_ffmpeg
def test_speech_like_audio_is_normalised_into_the_acx_window(tmp_path):
    import subprocess

    source = speech_like(tmp_path / "speech.wav")
    before = measure(source)
    assert before.peak_dbfs - before.rms_dbfs > 12, "test signal must have real crest"

    plan = plan_gain(before)
    mp3 = tmp_path / "out.mp3"
    wav_to_mp3(source, mp3, gain_db=plan.gain_db, limit_dbfs=plan.limit_dbfs)

    check = tmp_path / "check.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), str(check)], check=True)
    after = measure(check)

    assert -23.5 <= after.rms_dbfs <= -18.0
    assert after.peak_dbfs <= MAX_PEAK_DBFS + 0.5


def test_limiter_auto_level_is_disabled():
    """alimiter defaults to auto-levelling, which would undo the gain staging."""
    chain = loudness_filter(3.0, MAX_PEAK_DBFS)

    assert "level=disabled" in chain
    assert "volume=3.00dB" in chain
    assert "alimiter" in chain


# ---------------------------------------------------------------------------
# Encoding and tagging
# ---------------------------------------------------------------------------


@needs_ffmpeg
def test_mp3_encoding_preserves_duration(tmp_path):
    src = tone(tmp_path / "in.wav", seconds=3.0)
    dst = tmp_path / "out.mp3"

    wav_to_mp3(src, dst)

    assert dst.exists()
    assert probe_duration(dst) == pytest.approx(3.0, abs=0.1)


@needs_ffmpeg
def test_id3_tags_are_written(tmp_path):
    mp3 = tmp_path / "track.mp3"
    wav_to_mp3(tone(tmp_path / "in.wav"), mp3)
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 64)  # minimal JPEG header

    tag_mp3(
        mp3,
        TrackTags(
            title="Chapter Two",
            album="A Book",
            artist="An Author",
            track=2,
            total_tracks=17,
            year="2026",
        ),
        cover=cover,
    )

    tags = ID3(mp3)
    assert tags["TIT2"].text[0] == "Chapter Two"
    assert tags["TALB"].text[0] == "A Book"
    assert tags["TPE1"].text[0] == "An Author"
    # Album artist as well, or players scatter the book across entries.
    assert tags["TPE2"].text[0] == "An Author"
    assert tags["TRCK"].text[0] == "2/17"
    assert tags["TCON"].text[0] == "Audiobook"
    assert tags.getall("APIC")[0].data.startswith(b"\xff\xd8")


# ---------------------------------------------------------------------------
# M4B chapter metadata
# ---------------------------------------------------------------------------


def test_chapter_marks_are_cumulative_and_non_overlapping():
    meta = build_metadata(
        [
            M4BChapter("One", None, 10.0),
            M4BChapter("Two", None, 5.5),
            M4BChapter("Three", None, 2.0),
        ],
        title="A Book",
        artist="An Author",
    )

    starts = [int(line.split("=")[1]) for line in meta.splitlines() if line.startswith("START=")]
    ends = [int(line.split("=")[1]) for line in meta.splitlines() if line.startswith("END=")]

    assert starts == [0, 10_000, 15_500]
    assert ends == [9_999, 15_499, 17_499]
    # Each chapter ends before the next begins; overlaps make players skip one.
    assert all(e < s for e, s in zip(ends, starts[1:], strict=False))


def test_metadata_marks_the_file_as_an_audiobook():
    meta = build_metadata([M4BChapter("One", None, 1.0)], title="T", artist="A")

    assert "media_type=2" in meta
    assert "genre=Audiobook" in meta


def test_metadata_escapes_special_characters():
    meta = build_metadata([M4BChapter("Chapter = One; #1", None, 1.0)], title="A=B", artist="X;Y")

    assert r"title=Chapter \= One\; \#1" in meta
    assert r"title=A\=B" in meta
    assert r"artist=X\;Y" in meta


@needs_ffmpeg
def test_m4b_is_built_with_working_chapter_marks(tmp_path):
    from naudiobooker.audio import build_m4b

    chapters = [
        M4BChapter("First", tone(tmp_path / "a.wav", seconds=2.0), 2.0),
        M4BChapter("Second", tone(tmp_path / "b.wav", seconds=3.0), 3.0),
    ]
    out = tmp_path / "book.m4b"

    build_m4b(chapters, out, title="A Book", artist="An Author", work_dir=tmp_path)

    assert out.exists()
    assert probe_duration(out) == pytest.approx(5.0, abs=0.3)

    import json
    import subprocess

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters", str(out)],
        capture_output=True,
        text=True,
        check=True,
    )
    found = json.loads(probe.stdout)["chapters"]
    assert [c["tags"]["title"] for c in found] == ["First", "Second"]
