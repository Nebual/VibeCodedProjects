"""Node-container environment faults, and whether they explain themselves.

Both of these shipped in a working-looking image and failed only in use: one
at model load, one on the first chunk after the model had loaded and the node
had reported itself healthy. Neither original message named its cause, let
alone its fix, so each is translated at the point it is raised.
"""

from __future__ import annotations

import sys
import types

import pytest

from naudiobooker.tts.base import BackendUnavailable
from naudiobooker.tts.chatterbox_backend import _check_watermarker
from naudiobooker.tts.omnivoice_backend import _explain

# ---------------------------------------------------------------------------
# Chatterbox: resemble-perth swallowing an ImportError
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_perth(monkeypatch):
    """Stand in for the perth module, which is not installed here."""

    def install(watermarker: object) -> None:
        module = types.ModuleType("perth")
        module.PerthImplicitWatermarker = watermarker
        monkeypatch.setitem(sys.modules, "perth", module)

    return install


def test_broken_watermarker_is_reported_with_its_fix(fake_perth) -> None:
    # Exactly what perth does when pkg_resources is missing: it catches the
    # ImportError and leaves the name bound to None.
    fake_perth(None)

    with pytest.raises(BackendUnavailable) as excinfo:
        _check_watermarker()

    message = str(excinfo.value)
    assert "setuptools<81" in message, "the message must name the fix"
    # The unsearchable error someone would otherwise be staring at.
    assert "'NoneType' object is not callable" in message


def test_a_working_watermarker_passes(fake_perth) -> None:
    fake_perth(object())

    _check_watermarker()


def test_perth_missing_entirely_is_not_treated_as_broken(monkeypatch) -> None:
    """Absent is not the same as broken: only a None watermarker is the bug."""
    monkeypatch.setitem(sys.modules, "perth", None)

    _check_watermarker()


# ---------------------------------------------------------------------------
# OmniVoice: Triton with no C compiler in the image
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        "Failed to find C compiler. Please specify via CC environment variable"
        " or set triton.knobs.build.impl.",
        "triton.knobs.build.impl is not set",
    ],
)
def test_missing_compiler_is_reported_with_its_fix(message) -> None:
    explained = _explain(RuntimeError(message))

    assert "build-essential" in explained, "the message must name the fix"
    # The original text is kept: it is what someone will paste into a search.
    assert message in explained


def test_unrelated_failures_are_passed_through_untouched() -> None:
    assert _explain(RuntimeError("CUDA out of memory")) == "CUDA out of memory"
