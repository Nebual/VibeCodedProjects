"""Cloned voice management and the model catalogue."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import get_settings
from ..models import ModelInfo, TuningKnobInfo, VoiceClipInfo
from ..tts import BackendUnavailable, TTSError, get_backend
from ..tts.models import ALL_MODELS, get_model
from ..voices import VoiceError, VoiceLibrary

router = APIRouter(tags=["voices"])

#: A reference clip is seconds of speech. Anything much larger is a mistake.
MAX_CLIP_BYTES = 25 * 1024 * 1024


def _library() -> VoiceLibrary:
    return VoiceLibrary.open()


@router.get("/models", response_model=list[ModelInfo])
def list_models() -> list[ModelInfo]:
    """Every model this build knows about, available or not.

    Deliberately includes models that cannot run right now. A cloning model
    that needs the GPU node should be visible and explain itself, rather than
    silently not existing and leaving someone to wonder where the feature went.
    """
    settings = get_settings()
    return [
        ModelInfo(
            id=spec.id,
            label=spec.label,
            family=spec.family,
            supports_cloning=spec.supports_cloning,
            has_builtin_voices=spec.has_builtin_voices,
            cpu_viable=spec.cpu_viable,
            gpu_rtf_hint=spec.gpu_rtf_hint,
            notes=spec.notes,
            node_url=settings.node_url_for(spec.id) if settings.is_remote else None,
            is_default=spec.id == settings.tts_model,
            tuning=[TuningKnobInfo(**vars(knob)) for knob in spec.tuning],
        )
        for spec in ALL_MODELS
    ]


def _node_backend_for(model_id: str):
    """The backend for a model, plus whether it lives on a node at all."""
    try:
        spec = get_model(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        return spec, get_backend(get_settings(), spec.id), None
    except (BackendUnavailable, NotImplementedError) as exc:
        return spec, None, str(exc)


@router.get("/models/{model_id}/warm")
def warm_status(model_id: str) -> dict:
    """Whether this model is loaded on its node.

    Asked when a model is selected, so the UI can offer to warm it or say it
    already is. Costs one cheap health check; it never triggers a load, which
    is the whole reason /node/health stopped doing that.
    """
    spec, backend, error = _node_backend_for(model_id)
    if backend is None:
        return {"warm": None, "warmable": False, "detail": error}

    is_warm = getattr(backend, "is_warm", None)
    if not callable(is_warm):
        # A local backend loads in this process on first use; there is no
        # separate machine to get ahead of, so there is nothing to offer.
        return {"warm": None, "warmable": False, "detail": "runs locally"}

    try:
        return {"warm": bool(is_warm()), "warmable": True, "detail": spec.label}
    except BackendUnavailable as exc:
        return {"warm": None, "warmable": True, "detail": str(exc)}


@router.post("/models/{model_id}/warm")
def warm_model(model_id: str) -> dict:
    """Start loading a model so the first preview does not wait for it.

    Called when a model is picked in the UI. Deliberately best-effort: a
    failure here is a slower preview, never a broken one, so it reports rather
    than raises.
    """
    spec, backend, error = _node_backend_for(model_id)
    if backend is None:
        return {"warmed": False, "detail": error}

    warm = getattr(backend, "warm", None)
    if not callable(warm):
        # A local backend loads on first use in this same process; there is no
        # separate machine to get ahead of.
        return {"warmed": False, "detail": "nothing to warm for a local model"}

    try:
        warmed = bool(warm())
    except (BackendUnavailable, TTSError) as exc:
        # Never a 500: warming is optional, and the caller only needs to know
        # it did not happen and why.
        return {"warmed": False, "detail": str(exc)}

    return {
        "warmed": warmed,
        "detail": f"{spec.label} is ready" if warmed else f"could not warm {spec.label}",
    }


@router.get("/voice-clips", response_model=list[VoiceClipInfo])
def list_clips() -> list[VoiceClipInfo]:
    return [VoiceClipInfo(**clip.to_json()) for clip in _library().all()]


@router.post("/voice-clips", response_model=VoiceClipInfo, status_code=201)
def upload_clip(
    name: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
) -> VoiceClipInfo:
    data = file.file.read(MAX_CLIP_BYTES + 1)
    if len(data) > MAX_CLIP_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Reference clips are limited to {MAX_CLIP_BYTES // 1024 // 1024} MB.",
        )
    if not data:
        raise HTTPException(status_code=400, detail="That file is empty.")

    try:
        clip = _library().add(name, data)
    except VoiceError as exc:
        # These messages say what to do about it, so pass them straight through.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return VoiceClipInfo(**clip.to_json())


@router.get("/voice-clips/{clip_id}/audio")
def get_clip_audio(clip_id: str) -> FileResponse:
    library = _library()
    clip = library.get(clip_id)
    if clip is None:
        raise HTTPException(status_code=404, detail="No such voice clip")
    return FileResponse(library.path_for(clip), media_type="audio/wav", filename=f"{clip.name}.wav")


@router.delete("/voice-clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str) -> None:
    if not _library().remove(clip_id):
        raise HTTPException(status_code=404, detail="No such voice clip")
