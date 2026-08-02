"""TTS layer, exercised through a fake backend.

Nothing here loads Kokoro. The real model is 326 MB and takes half a second to
initialise; making the suite depend on it would mean tests that cannot run on a
fresh checkout. The fake implements the same protocol, which is the point of
having a protocol.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from naudiobooker.audio import to_wav_bytes
from naudiobooker.main import create_app
from naudiobooker.tts.base import (
    AudioChunk,
    BackendHealth,
    BackendUnavailable,
    TTSBackend,
    TTSError,
    Voice,
)
from naudiobooker.tts.kokoro_local import _describe


class FakeBackend:
    """Produces a tone whose length tracks the input, so timing is meaningful."""

    id = "fake"
    model_version = "fake-1"
    sample_rate = 24_000
    max_chars = 200

    def __init__(self, *, available: bool = True) -> None:
        self._available = available
        self.calls: list[tuple[str, str, float]] = []
        #: Reference clip passed with each call, so tests can assert a cloned
        #: voice actually reached the backend rather than being dropped.
        self.references: list[object] = []

    def voices(self) -> list[Voice]:
        if not self._available:
            raise BackendUnavailable("no model")
        return [
            Voice(id="fk_ann", label="Ann (English, female)", language="en-us", gender="female"),
            Voice(id="fk_bob", label="Bob (English, male)", language="en-us", gender="male"),
        ]

    def synthesize(
        self,
        text: str,
        voice: str,
        speed: float = 1.0,
        reference=None,
    ) -> AudioChunk:
        if not self._available:
            raise BackendUnavailable("no model")
        if not text.strip():
            raise TTSError("nothing to synthesize")
        self.references.append(reference)
        self.calls.append((text, voice, speed))
        n = int(self.sample_rate * len(text) / 100 / speed)
        t = np.arange(n, dtype=np.float32) / self.sample_rate
        return AudioChunk(samples=np.sin(2 * np.pi * 220 * t) * 0.2, sample_rate=self.sample_rate)

    def health(self) -> BackendHealth:
        return BackendHealth(available=self._available, detail="fake")


@pytest.fixture
def fake(monkeypatch) -> FakeBackend:
    backend = FakeBackend()
    monkeypatch.setattr("naudiobooker.routes.tts.get_backend", lambda *a, **k: backend)
    return backend


# --------------------------------------------------------------------------
# Protocol and helpers
# --------------------------------------------------------------------------


def test_fake_satisfies_the_protocol() -> None:
    assert isinstance(FakeBackend(), TTSBackend)


def test_audio_chunk_reports_duration() -> None:
    chunk = AudioChunk(samples=np.zeros(24_000, dtype=np.float32), sample_rate=24_000)

    assert chunk.duration_s == pytest.approx(1.0)


def test_wav_encoding_round_trips() -> None:
    chunk = FakeBackend().synthesize("hello there", "fk_ann")

    data = to_wav_bytes(chunk)
    samples, sample_rate = sf.read(io.BytesIO(data))

    assert data[:4] == b"RIFF"
    assert sample_rate == 24_000
    assert len(samples) == len(chunk.samples)


@pytest.mark.parametrize(
    ("voice_id", "language", "gender"),
    [
        ("af_heart", "en-us", "female"),
        ("am_adam", "en-us", "male"),
        ("bf_emma", "en-gb", "female"),
        ("bm_george", "en-gb", "male"),
        ("jf_alpha", "ja", "female"),
        ("zm_yunxi", "cmn", "male"),
    ],
)
def test_kokoro_voice_ids_are_decoded(voice_id, language, gender) -> None:
    voice = _describe(voice_id)

    assert voice.id == voice_id
    assert voice.language == language
    assert voice.gender == gender


def test_unknown_voice_prefix_still_yields_a_voice() -> None:
    """A voice added by a future model release must not vanish from the list."""
    voice = _describe("qq_mystery")

    assert voice.id == "qq_mystery"
    assert voice.label


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


def test_voices_endpoint(fake) -> None:
    with TestClient(create_app()) as client:
        body = client.get("/voices").json()

    assert [v["id"] for v in body] == ["fk_ann", "fk_bob"]
    assert body[0]["gender"] == "female"


class MultilingualBackend(FakeBackend):
    """Stands in for Kokoro's 54 voices across nine languages."""

    def voices(self) -> list[Voice]:
        return [
            Voice(id="af_heart", label="Heart", language="en-us", gender="female"),
            Voice(id="bm_george", label="George", language="en-gb", gender="male"),
            Voice(id="jf_alpha", label="Alpha", language="ja", gender="female"),
            Voice(id="zm_yunxi", label="Yunxi", language="cmn", gender="male"),
            Voice(id="ef_dora", label="Dora", language="es", gender="female"),
        ]


@pytest.fixture
def multilingual(monkeypatch) -> MultilingualBackend:
    backend = MultilingualBackend()
    monkeypatch.setattr("naudiobooker.routes.tts.get_backend", lambda *a, **k: backend)
    return backend


def test_only_english_voices_are_offered(multilingual) -> None:
    with TestClient(create_app()) as client:
        body = client.get("/voices").json()

    assert [v["id"] for v in body] == ["af_heart", "bm_george"]
    assert {v["language"] for v in body} == {"en-us", "en-gb"}


def test_all_languages_can_be_requested(multilingual) -> None:
    """An escape hatch that needs neither a config change nor a restart."""
    with TestClient(create_app()) as client:
        body = client.get("/voices", params={"all_languages": True}).json()

    assert len(body) == 5


def test_an_empty_language_list_disables_filtering(multilingual, monkeypatch) -> None:
    from naudiobooker.config import Settings, get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(
        "naudiobooker.routes.tts.get_settings",
        lambda: Settings(voice_languages=[]),
    )

    with TestClient(create_app()) as client:
        body = client.get("/voices").json()

    assert len(body) == 5


def test_filtering_is_case_insensitive(multilingual, monkeypatch) -> None:
    from naudiobooker.config import Settings

    monkeypatch.setattr(
        "naudiobooker.routes.tts.get_settings",
        lambda: Settings(voice_languages=["EN-US"]),
    )

    with TestClient(create_app()) as client:
        body = client.get("/voices").json()

    assert [v["id"] for v in body] == ["af_heart"]


def test_preview_returns_wav(fake) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": "fk_ann"})

    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    assert res.content[:4] == b"RIFF"
    assert float(res.headers["X-Audio-Duration"]) > 0


def test_preview_uses_the_sample_text_when_none_given(fake) -> None:
    with TestClient(create_app()) as client:
        client.post("/preview", json={"voice": "fk_bob"})

    text, voice, _ = fake.calls[-1]
    assert voice == "fk_bob"
    assert len(text) > 40


def test_preview_honours_supplied_text(fake) -> None:
    with TestClient(create_app()) as client:
        client.post("/preview", json={"voice": "fk_ann", "text": "Just this."})

    assert fake.calls[-1][0] == "Just this."


def test_preview_rejects_overlong_text(fake) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": "fk_ann", "text": "x" * 5000})

    assert res.status_code == 413


@pytest.mark.parametrize("speed", [0.4, 2.5])
def test_preview_rejects_out_of_range_speed(fake, speed) -> None:
    with TestClient(create_app()) as client:
        res = client.post("/preview", json={"voice": "fk_ann", "speed": speed})

    assert res.status_code == 422


def test_unavailable_backend_reports_503(monkeypatch) -> None:
    def boom(*args, **kwargs):
        raise BackendUnavailable("model files not found")

    monkeypatch.setattr("naudiobooker.routes.tts.get_backend", boom)

    with TestClient(create_app()) as client:
        res = client.get("/voices")

    assert res.status_code == 503
    assert "model files" in res.json()["detail"]


# ---------------------------------------------------------------------------
# Protocol conformance
# ---------------------------------------------------------------------------


def real_backend_classes():
    """Every concrete backend, imported without needing its model installed."""
    from naudiobooker.tts.chatterbox_backend import ChatterboxBackend
    from naudiobooker.tts.fallback import FallbackBackend
    from naudiobooker.tts.kokoro_local import KokoroLocalBackend
    from naudiobooker.tts.omnivoice_backend import OmniVoiceBackend
    from naudiobooker.tts.remote_http import RemoteHttpBackend

    return [
        KokoroLocalBackend,
        ChatterboxBackend,
        OmniVoiceBackend,
        RemoteHttpBackend,
        FallbackBackend,
    ]


@pytest.mark.parametrize("cls", real_backend_classes(), ids=lambda c: c.__name__)
def test_every_backend_accepts_the_full_synthesize_signature(cls) -> None:
    """The worker calls synthesize(text, voice, speed, reference) positionally.

    This exists because adding `reference` to the protocol silently missed
    KokoroLocalBackend -- the default model -- and no test caught it: every
    worker test uses a fake, so no real backend was ever called through the
    protocol. The symptom would have been a TypeError on the first chunk of an
    ordinary render.
    """
    import inspect

    params = list(inspect.signature(cls.synthesize).parameters)

    assert params[:5] == ["self", "text", "voice", "speed", "reference"], (
        f"{cls.__name__}.synthesize does not match the protocol: {params}"
    )


@pytest.mark.parametrize("cls", real_backend_classes(), ids=lambda c: c.__name__)
def test_every_backend_declares_the_protocol_methods(cls) -> None:
    """Methods only.

    model_version, sample_rate and max_chars are deliberately not checked here:
    several backends set them in __init__ because they depend on settings or on
    what a remote node reports, so they do not exist on the class. Asserting on
    the class would only be testing where the attribute happens to be defined.
    """
    for name in ("voices", "synthesize", "health"):
        assert callable(getattr(cls, name, None)), f"{cls.__name__} is missing {name}()"
