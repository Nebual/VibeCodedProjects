"""Voice listing and preview synthesis.

Sync handlers on purpose: synthesis is CPU-bound, and FastAPI runs these on a
threadpool so a preview does not stall the event loop.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..audio import to_wav_bytes
from ..config import get_settings
from ..models import PreviewRequest, VoiceInfo
from ..tts import BackendUnavailable, TTSError, get_backend

router = APIRouter(tags=["tts"])

#: Long enough to judge a voice's character, short enough to render instantly.
SAMPLE_TEXT = (
    "The harbour lights came on one by one, and the town settled into evening. "
    "She had waited three years for this, and now that it was here, "
    "she found she had nothing at all to say."
)

MAX_PREVIEW_CHARS = 600


@router.get("/voices", response_model=list[VoiceInfo])
def list_voices() -> list[VoiceInfo]:
    try:
        backend = get_backend()
        return [
            VoiceInfo(id=v.id, label=v.label, language=v.language, gender=v.gender)
            for v in backend.voices()
        ]
    except (BackendUnavailable, NotImplementedError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post(
    "/preview",
    responses={200: {"content": {"audio/wav": {}}, "description": "WAV audio"}},
)
def preview(request: PreviewRequest) -> Response:
    settings = get_settings()
    text = (request.text or SAMPLE_TEXT).strip()
    if len(text) > MAX_PREVIEW_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Preview text is limited to {MAX_PREVIEW_CHARS} characters",
        )

    try:
        backend = get_backend()
        chunk = backend.synthesize(text, request.voice or settings.tts_voice, request.speed)
    except (BackendUnavailable, NotImplementedError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TTSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return Response(
        content=to_wav_bytes(chunk),
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Duration": f"{chunk.duration_s:.2f}",
        },
    )
