"""Cloned voice management and the model catalogue."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import get_settings
from ..models import ModelInfo, VoiceClipInfo
from ..tts.models import ALL_MODELS
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
        )
        for spec in ALL_MODELS
    ]


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
    return FileResponse(
        library.path_for(clip), media_type="audio/wav", filename=f"{clip.name}.wav"
    )


@router.delete("/voice-clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str) -> None:
    if not _library().remove(clip_id):
        raise HTTPException(status_code=404, detail="No such voice clip")
