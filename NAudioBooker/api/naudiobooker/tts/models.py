"""The catalogue of synthesis models.

Separate from the backends themselves because the UI needs to describe models
it cannot currently run -- a cloning model that only makes sense on the GPU node
should still be visible, and should say why it is unavailable rather than
silently not existing.
"""

from __future__ import annotations

from dataclasses import dataclass

Family = str


@dataclass(frozen=True)
class TuningKnob:
    """One per-request control a model exposes.

    Described here rather than hardcoded in the UI so a model's controls
    travel with the model: the front end renders whatever a spec declares,
    and adding a knob to another model needs no front-end change.
    """

    #: Must match a field name on ModelOptions.
    id: str
    label: str
    minimum: float
    maximum: float
    step: float
    default: float
    hint: str


#: Resemble's guidance, which is specific enough to be worth passing on rather
#: than paraphrasing: the defaults suit most prompts; a fast-talking reference
#: clip does better with cfg_weight nearer 0.3; and for dramatic reads, raise
#: exaggeration to ~0.7 and drop cfg_weight to ~0.3, because exaggeration
#: speeds speech up and a lower cfg_weight slows the pacing back down.
CHATTERBOX_TUNING = (
    TuningKnob(
        id="exaggeration",
        label="Exaggeration",
        minimum=0.25,
        maximum=1.0,
        step=0.05,
        default=0.5,
        hint="How dramatic the delivery is. Raising it also speeds speech up.",
    ),
    TuningKnob(
        id="cfg_weight",
        label="Pacing (CFG weight)",
        minimum=0.2,
        maximum=1.0,
        step=0.05,
        default=0.5,
        hint="Lower is slower and more deliberate. Try 0.3 for a fast "
        "reference clip, or to offset high exaggeration.",
    ),
)


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    family: Family
    #: Zero-shot cloning from a user-supplied reference clip.
    supports_cloning: bool
    #: Ships a fixed set of named voices.
    has_builtin_voices: bool
    #: Rough real-time factor on a mid-range GPU, as audio-seconds per second.
    #: Indicative only, and deliberately conservative: published figures for
    #: these models come from datacentre GPUs with batching, and taking them at
    #: face value led to an estimate that was an order of magnitude out. The
    #: benchmark script is the authority; this exists only to warn someone
    #: before they start a render that will run overnight.
    gpu_rtf_hint: float | None
    #: Whether running on CPU is sane for a whole book, as opposed to merely
    #: possible.
    cpu_viable: bool
    notes: str
    #: Per-request controls this model exposes. Empty for models with none.
    tuning: tuple[TuningKnob, ...] = ()


#: Kokoro is the default for a reason: non-autoregressive, so identical text
#: always yields identical audio and it cannot drift over a long book. The
#: cloning models below are worth the cost for a favourite book, not for bulk.
KOKORO = ModelSpec(
    id="kokoro",
    label="Kokoro 82M",
    family="kokoro",
    supports_cloning=False,
    has_builtin_voices=True,
    gpu_rtf_hint=45.0,
    cpu_viable=True,
    notes="Fast and stable. 28 English voices, no cloning.",
)

CHATTERBOX_ORIGINAL = ModelSpec(
    id="chatterbox-original",
    label="Chatterbox 0.5B (English)",
    family="chatterbox",
    supports_cloning=True,
    has_builtin_voices=False,
    # Measured: 2.16x on an RTX 3070, 0.06x on an 8-core CPU.
    #
    # Worth recording why the CPU figure is useless for predicting the GPU one.
    # Chatterbox is twice OmniVoice's speed on CPU, which suggests ~7x on a
    # 3070; it actually reaches 2.16x, slower than OmniVoice's 3.5x.
    # Autoregressive decoding and diffusion do not scale onto a GPU by the same
    # factor, so a CPU ratio predicts nothing.
    gpu_rtf_hint=2.16,
    cpu_viable=False,
    notes=("A slower, high quality model with voice cloning."),
    tuning=CHATTERBOX_TUNING,
)

OMNIVOICE = ModelSpec(
    id="omnivoice",
    label="OmniVoice 0.6B",
    family="omnivoice",
    supports_cloning=True,
    has_builtin_voices=False,
    # Measured: 3.5x on an RTX 3070, and 0.03x on an 8-core CPU. The project's
    # headline 40x is an H100 at batch-8 with FlashInfer and does not transfer
    # to single-item requests on a consumer card -- taking it at face value put
    # an earlier estimate an order of magnitude out.
    gpu_rtf_hint=3.5,
    cpu_viable=False,
    notes=("Voice cloning from a 3-10 second clip."),
)

#: Chatterbox also ships Turbo (350M) and Nano (110M) English variants. Nano in
#: particular claims to beat real time on CPU, which would make cloning viable
#: without the GPU node -- worth adding once Original and OmniVoice have been
#: judged on quality, since they are the same backend with another checkpoint.
ALL_MODELS: tuple[ModelSpec, ...] = (
    KOKORO,
    CHATTERBOX_ORIGINAL,
    OMNIVOICE,
)

_BY_ID = {spec.id: spec for spec in ALL_MODELS}


def get_model(model_id: str) -> ModelSpec:
    try:
        return _BY_ID[model_id]
    except KeyError:
        raise ValueError(
            f"unknown model {model_id!r}; known: {', '.join(sorted(_BY_ID))}"
        ) from None


def known_model_ids() -> list[str]:
    return [spec.id for spec in ALL_MODELS]
