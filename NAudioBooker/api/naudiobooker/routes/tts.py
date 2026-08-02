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
from ..tts.models import ModelSpec, get_model
from ..voices import VoiceError, resolve_reference

router = APIRouter(tags=["tts"])


def _model_or_400(model_id: str) -> ModelSpec:
    try:
        return get_model(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


#: Long enough to judge a voice's character, short enough to render instantly.
SAMPLE_TEXT = (
    "The harbour lights came on one by one, and the town settled into evening. "
    "She had waited three years for this, and now that it was here, "
    "she found she had nothing at all to say."
)

MAX_PREVIEW_CHARS = 600


@router.get("/voices", response_model=list[VoiceInfo])
def list_voices(all_languages: bool = False) -> list[VoiceInfo]:
    """Voices offered for narration.

    Filtered here rather than in a backend so the same list comes back whether
    synthesis is local or on a remote node. ``?all_languages=true`` bypasses the
    filter without needing a config change or a restart.
    """
    settings = get_settings()
    wanted = {lang.lower() for lang in settings.voice_languages}

    try:
        backend = get_backend()
        voices = backend.voices()
    except (BackendUnavailable, NotImplementedError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if wanted and not all_languages:
        voices = [v for v in voices if v.language.lower() in wanted]

    return [VoiceInfo(id=v.id, label=v.label, language=v.language, gender=v.gender) for v in voices]


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

    # The model the caller picked, not the configured default. Forgetting this
    # argument is invisible: every request quietly renders on the default model
    # and the only clue is that a cloned voice "does not exist".
    spec = _model_or_400(request.model or settings.tts_model)

    try:
        reference = resolve_reference(spec, request.voice)
    except VoiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        backend = get_backend(settings, spec.id)
        chunk = backend.synthesize(
            text,
            request.voice or settings.tts_voice,
            request.speed,
            reference,
        )
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
