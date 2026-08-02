"""Per-request model tuning: Chatterbox's exaggeration and cfg_weight.

The knobs change the audio, so the thing most worth pinning down is that they
change the cache key too. A slider that alters the sound but not the key would
serve the first setting's audio forever, and "the slider does nothing after the
first try" points nowhere near a cache.
"""

from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient
from test_model_selection import backends, book, clip, env  # noqa: F401

from naudiobooker import jobs as job_queue
from naudiobooker.cache import chunk_key
from naudiobooker.main import create_app
from naudiobooker.tts.base import NO_OPTIONS, ModelOptions
from naudiobooker.tts.models import get_model

TUNED = {"exaggeration": 0.7, "cfg_weight": 0.3}


# ---------------------------------------------------------------------------
# The cache key
# ---------------------------------------------------------------------------


BASE_KEY = dict(model_version="m-1", voice="v", speed=1.0, text="hello")


def _key_before_tuning_existed(
    *, model_version: str, voice: str, speed: float, text: str, voice_ref: str | None = None
) -> str:
    """The previous implementation of chunk_key, reproduced verbatim.

    Compared against rather than a recorded hash constant: a constant only
    proves the code agrees with whatever it produced when the constant was
    generated, which is no evidence at all if it was generated afterwards.
    """
    digest = hashlib.sha256()
    for part in (model_version, voice, voice_ref or "", f"{speed:.4f}", text):
        encoded = part.encode("utf-8")
        digest.update(str(len(encoded)).encode("ascii"))
        digest.update(b"\0")
        digest.update(encoded)
    return digest.hexdigest()


def test_untuned_keys_are_unchanged_by_the_new_field() -> None:
    """Adding options must not invalidate a cache full of finished books.

    An empty token is appended as nothing at all rather than as an empty
    field, so untuned audio keeps the key it was written under.
    """
    assert chunk_key(**BASE_KEY) == chunk_key(**BASE_KEY, options="")
    assert chunk_key(**BASE_KEY) == _key_before_tuning_existed(**BASE_KEY)
    assert chunk_key(**BASE_KEY, voice_ref="abc") == _key_before_tuning_existed(
        **BASE_KEY, voice_ref="abc"
    )


def test_tuning_changes_the_key() -> None:
    tuned = ModelOptions(**TUNED).cache_token()

    assert chunk_key(**BASE_KEY, options=tuned) != chunk_key(**BASE_KEY)


def test_each_knob_is_distinguished() -> None:
    keys = {
        chunk_key(**BASE_KEY, options=ModelOptions(**opts).cache_token())
        for opts in (
            {},
            {"exaggeration": 0.7},
            {"exaggeration": 0.8},
            {"cfg_weight": 0.3},
            {"exaggeration": 0.7, "cfg_weight": 0.3},
        )
    }

    assert len(keys) == 5


def test_the_token_does_not_depend_on_field_order() -> None:
    a = ModelOptions(exaggeration=0.7, cfg_weight=0.3).cache_token()
    b = ModelOptions.from_dict({"cfg_weight": 0.3, "exaggeration": 0.7}).cache_token()

    assert a == b


def test_zero_is_a_value_not_an_absence() -> None:
    """Both knobs are meaningful at 0.0, so it must not read as "unset"."""
    assert ModelOptions(exaggeration=0.0).cache_token() != NO_OPTIONS.cache_token()
    assert ModelOptions(exaggeration=0.0).as_dict() == {"exaggeration": 0.0}


# ---------------------------------------------------------------------------
# Reaching the model
# ---------------------------------------------------------------------------


def test_preview_hands_the_tuning_to_the_backend(backends, clip) -> None:  # noqa: F811
    with TestClient(create_app()) as client:
        res = client.post(
            "/preview",
            json={
                "voice": clip.id,
                "model": "chatterbox-original",
                "text": "dramatic",
                "options": TUNED,
            },
        )

    assert res.status_code == 200, res.text
    passed = backends["chatterbox"].options[0]
    assert passed.exaggeration == 0.7
    assert passed.cfg_weight == 0.3


def test_two_tunings_do_not_share_cached_audio(backends, clip) -> None:  # noqa: F811
    """The comparison workflow: same text and voice, different settings."""
    base = {"voice": clip.id, "model": "chatterbox-original", "text": "identical"}

    with TestClient(create_app()) as client:
        first = client.post("/preview", json={**base, "options": {"exaggeration": 0.5}})
        second = client.post("/preview", json={**base, "options": {"exaggeration": 0.9}})
        again = client.post("/preview", json={**base, "options": {"exaggeration": 0.5}})

    assert first.headers["x-cache"] == "miss"
    assert second.headers["x-cache"] == "miss"
    assert again.headers["x-cache"] == "hit"
    assert len(backends["chatterbox"].calls) == 2


def test_render_persists_the_tuning_on_the_job(backends, book, clip) -> None:  # noqa: F811
    with TestClient(create_app()) as client:
        res = client.post(
            f"/books/{book.id}/render",
            json={"voice": clip.id, "model": "chatterbox-original", "options": TUNED},
        )

    assert res.status_code == 201, res.text
    # Read back through the queue: the worker reads the row hours later, and
    # a column that silently dropped would look fine in the response.
    job = job_queue.get_job(res.json()["id"])
    assert job.options == TUNED


def test_an_untuned_render_stores_no_options(backends, book) -> None:  # noqa: F811
    with TestClient(create_app()) as client:
        res = client.post(f"/books/{book.id}/render", json={"voice": "af_heart"})

    assert job_queue.get_job(res.json()["id"]).options == {}


# ---------------------------------------------------------------------------
# What the UI is told
# ---------------------------------------------------------------------------


def test_the_catalogue_describes_chatterbox_knobs(backends) -> None:  # noqa: F811
    with TestClient(create_app()) as client:
        models = {m["id"]: m for m in client.get("/models").json()}

    knobs = {k["id"]: k for k in models["chatterbox-original"]["tuning"]}
    assert set(knobs) == {"exaggeration", "cfg_weight"}
    assert knobs["exaggeration"]["default"] == 0.5
    assert knobs["cfg_weight"]["minimum"] <= 0.3 <= knobs["cfg_weight"]["maximum"]
    # Models without controls must say so, or the UI would render empty sliders.
    assert models["kokoro"]["tuning"] == []
    assert models["omnivoice"]["tuning"] == []


@pytest.mark.parametrize("knob", get_model("chatterbox-original").tuning, ids=lambda k: k.id)
def test_every_declared_knob_is_a_real_model_option(knob) -> None:
    """A knob the UI can move but ModelOptions cannot carry would do nothing."""
    assert hasattr(ModelOptions(), knob.id)
    assert knob.minimum <= knob.default <= knob.maximum
