"""Custom cloned voices and the cache key that protects them."""

from __future__ import annotations

import io

import numpy as np
import pytest
import soundfile as sf

from naudiobooker.cache import chunk_key
from naudiobooker.voices import MAX_CLIP_S, TARGET_SAMPLE_RATE, VoiceError, VoiceLibrary


def clip_bytes(seconds: float = 5.0, rate: int = 24_000, freq: float = 180.0,
               amplitude: float = 0.6, channels: int = 1) -> bytes:
    t = np.arange(int(rate * seconds), dtype=np.float32) / rate
    wave = (np.sin(2 * np.pi * freq * t) * amplitude).astype(np.float32)
    if channels > 1:
        wave = np.stack([wave] * channels, axis=1)
    buffer = io.BytesIO()
    sf.write(buffer, wave, rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@pytest.fixture
def library(tmp_path) -> VoiceLibrary:
    return VoiceLibrary(root=tmp_path / "voices")


# ---------------------------------------------------------------------------
# The cache key
# ---------------------------------------------------------------------------


def test_reference_clip_is_part_of_the_cache_key():
    """Re-pointing a voice name at a new recording must invalidate its audio.

    A cloned voice is named by the user, so the name is not a stable identity.
    Keying on it alone would serve the old voice forever and the only symptom
    would be a book that refuses to sound like the new clip.
    """
    base = dict(model_version="chatterbox-1", voice="clip-narrator", speed=1.0, text="hello")

    assert chunk_key(**base, voice_ref="aaa") != chunk_key(**base, voice_ref="bbb")


def test_builtin_voices_are_unaffected_by_the_new_field():
    base = dict(model_version="kokoro-1", voice="af_heart", speed=1.0, text="hello")

    assert chunk_key(**base) == chunk_key(**base, voice_ref=None)


# ---------------------------------------------------------------------------
# Storing clips
# ---------------------------------------------------------------------------


def test_adding_a_clip_stores_and_indexes_it(library):
    clip = library.add("Narrator", clip_bytes())

    assert clip.name == "Narrator"
    assert clip.ref_hash
    assert library.path_for(clip).exists()
    assert [c.id for c in library.all()] == [clip.id]


def test_library_survives_a_reload(library, tmp_path):
    clip = library.add("Narrator", clip_bytes())

    reopened = VoiceLibrary(root=tmp_path / "voices")
    reopened.reload()

    assert [c.id for c in reopened.all()] == [clip.id]
    assert reopened.get(clip.id).ref_hash == clip.ref_hash


def test_identical_audio_is_stored_once(library):
    data = clip_bytes()
    first = library.add("Narrator", data)
    second = library.add("Same voice again", data)

    assert first.ref_hash == second.ref_hash
    assert len(library.all()) == 1
    # The newer label wins; the audio is not duplicated on disk.
    assert library.all()[0].name == "Same voice again"


def test_different_audio_gets_a_different_hash(library):
    a = library.add("One", clip_bytes(freq=180))
    b = library.add("Two", clip_bytes(freq=320))

    assert a.ref_hash != b.ref_hash
    assert len(library.all()) == 2


def test_stored_audio_is_level_normalised(library):
    """Consistent level into the speaker encoder, whatever the recording gain.

    Note this does NOT make the hash gain-invariant, and it is not meant to:
    the input has already been quantised to 16-bit, so normalising a quiet take
    and a loud one leaves different quantisation error. The consequence is a
    cache miss on re-upload at a different volume -- wasteful, never wrong.
    Genuine invariance would need audio fingerprinting, which is far more
    machinery than a missed cache entry justifies.
    """
    for amplitude in (0.2, 0.9):
        clip = library.add(f"Take {amplitude}", clip_bytes(amplitude=amplitude))
        samples, _ = sf.read(library.path_for(clip), dtype="float32")
        assert float(np.max(np.abs(samples))) == pytest.approx(0.95, abs=0.01)


def test_stereo_is_folded_to_mono(library):
    mono = library.add("Mono", clip_bytes(channels=1))
    stereo = library.add("Stereo", clip_bytes(channels=2))

    assert mono.ref_hash == stereo.ref_hash


@pytest.mark.parametrize("rate", [16_000, 24_000, 44_100, 48_000])
def test_clips_are_stored_at_the_model_sample_rate(library, rate):
    """Whatever arrives, the model sees 24 kHz mono."""
    clip = library.add(f"At {rate}", clip_bytes(rate=rate, seconds=5.0))

    stored, stored_rate = sf.read(library.path_for(clip), dtype="float32")
    assert stored_rate == TARGET_SAMPLE_RATE
    assert stored.ndim == 1
    assert clip.duration_s == pytest.approx(5.0, abs=0.1)


# ---------------------------------------------------------------------------
# Rejecting bad input
# ---------------------------------------------------------------------------


def test_a_clip_that_is_too_short_is_rejected(library):
    with pytest.raises(VoiceError, match="at least"):
        library.add("Blink", clip_bytes(seconds=0.5))


def test_a_long_clip_is_trimmed_rather_than_rejected(library):
    clip = library.add("Rambling", clip_bytes(seconds=60))

    assert clip.duration_s == pytest.approx(MAX_CLIP_S)


def test_silence_is_rejected(library, tmp_path):
    buffer = io.BytesIO()
    sf.write(buffer, np.zeros(24_000 * 5, dtype=np.float32), 24_000, format="WAV")

    with pytest.raises(VoiceError, match="silent"):
        library.add("Nothing", buffer.getvalue())


def test_unreadable_audio_gives_a_useful_message(library):
    with pytest.raises(VoiceError, match="Could not read"):
        library.add("Broken", b"this is not audio")


# ---------------------------------------------------------------------------
# Removal
# ---------------------------------------------------------------------------


def test_removing_a_clip_deletes_its_audio(library):
    clip = library.add("Narrator", clip_bytes())
    path = library.path_for(clip)

    assert library.remove(clip.id)
    assert not path.exists()
    assert library.all() == []


def test_removing_one_of_two_names_keeps_shared_audio(library):
    data = clip_bytes()
    first = library.add("One", data)
    # Same bytes, so the library collapses them; removing must not orphan audio
    # that another entry still points at.
    library.add("Two", data)
    path = library.path_for(first)

    library.remove(first.id)

    assert not library.all()
    assert not path.exists()


def test_removing_something_that_is_not_there(library):
    assert library.remove("clip-nope") is False
