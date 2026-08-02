"""Voice listing and preview synthesis.

Sync handlers on purpose: synthesis is CPU-bound, and FastAPI runs these on a
threadpool so a preview does not stall the event loop.
"""

from __future__ import annotations

import re

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..audio import audio_to_mp4, to_wav_bytes
from ..cache import ChunkCache, chunk_key
from ..config import get_settings
from ..models import PreviewRequest, VoiceInfo
from ..text.chunker import chunk_paragraphs
from ..tts import BackendUnavailable, TTSError, get_backend
from ..tts.base import AudioChunk, ModelOptions
from ..tts.models import ModelSpec, get_model
from ..voices import VoiceError, resolve_reference

router = APIRouter(tags=["tts"])


def _model_or_400(model_id: str) -> ModelSpec:
    try:
        return get_model(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _paragraphs(text: str) -> list[str]:
    """Split pasted text into paragraphs the chunker can work with.

    A blank line is a paragraph break, matching how chapter text is stored.
    Single newlines are left alone: pasted prose is often hard-wrapped, and
    treating every line as a paragraph would insert a long pause mid-sentence.
    """
    parts = [p.strip() for p in re.split(r"\n\s*\n", text)]
    return [p for p in parts if p] or [text]


def _silence(seconds: float, sample_rate: int) -> AudioChunk:
    return AudioChunk(
        samples=np.zeros(int(seconds * sample_rate), dtype=np.float32),
        sample_rate=sample_rate,
    )


def _join(pieces: list[AudioChunk]) -> AudioChunk:
    return AudioChunk(
        samples=np.concatenate([p.samples for p in pieces]),
        sample_rate=pieces[0].sample_rate,
    )


def _download_name(spec: ModelSpec, voice: str, speed: float, ext: str = "wav") -> str:
    """A filename that says which combination this was.

    Comparing voices means ending up with a folder of downloads, and
    "preview.wav (3)" tells you nothing about which one you liked.
    """
    stem = "-".join(
        re.sub(r"[^A-Za-z0-9]+", "-", part).strip("-")
        for part in (spec.id, voice or "default")
        if part
    )
    # Appended after sanitising so the decimal point survives: "1-25x" reads
    # like a serial number, "1.25x" reads like a speed.
    if abs(speed - 1.0) > 1e-3:
        stem += f"-{speed:.2f}x"
    return f"preview-{stem}.{ext}"


#: Long enough to judge a voice's character, short enough to render instantly.
SAMPLE_TEXT = (
    "The harbour lights came on one by one, and the town settled into evening. "
    "She had waited three years for this, and now that it was here, "
    "she found she had nothing at all to say."
)

#: Past this, a preview is really a render and belongs in a job: it holds a
#: threadpool worker for the duration and streams nothing back until it is
#: finished, so a long enough one just times out in the browser. The bound
#: exists to make that failure a clear message rather than a hung request --
#: it is not a judgement about how much text is reasonable to preview.
MAX_PREVIEW_CHARS = 20_000

#: Matches the renderer, so a previewed passage sounds like the finished book
#: rather than subtly differently paced.
SENTENCE_GAP_S = 0.30
PARAGRAPH_GAP_S = 0.65


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
            detail=(
                f"That is {len(text):,} characters; a preview is capped at "
                f"{MAX_PREVIEW_CHARS:,} because it renders in one request. "
                "For anything longer, upload it as a book and render it."
            ),
        )

    # The model the caller picked, not the configured default. Forgetting this
    # argument is invisible: every request quietly renders on the default model
    # and the only clue is that a cloned voice "does not exist".
    spec = _model_or_400(request.model or settings.tts_model)

    try:
        reference = resolve_reference(spec, request.voice)
    except VoiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    voice = request.voice or settings.tts_voice
    options = ModelOptions.from_dict(request.options)

    try:
        backend = get_backend(settings, spec.id)

        # The same cache the renderer uses, and deliberately not a separate
        # one: the key already covers everything that changes the audio, so a
        # preview and a render of identical text are the same entry. What this
        # buys is the thing previews are for -- flipping between two voices to
        # compare them costs one synthesis each, not one per click. On a
        # cloning model that is the difference between instant and half a
        # minute.
        cache = ChunkCache(settings.cache_dir)

        # Chunked exactly as a render is. Text longer than the model's
        # max_chars would otherwise be truncated or come out with mangled
        # prosody, and previewing arbitrary pasted text is a good deal of what
        # this screen is used for.
        chunks = chunk_paragraphs(_paragraphs(text), backend.max_chars)
        pieces: list[AudioChunk] = []
        hits = 0

        for position, piece in enumerate(chunks):
            key = chunk_key(
                model_version=backend.model_version,
                voice=voice,
                speed=request.speed,
                text=piece.text,
                voice_ref=reference.ref_hash if reference else None,
                options=options.cache_token(),
            )
            audio = cache.get(key)
            if audio is None:
                audio = backend.synthesize(piece.text, voice, request.speed, reference, options)
                cache.put(key, audio)
            else:
                hits += 1
            pieces.append(audio)

            if position < len(chunks) - 1:
                gap = PARAGRAPH_GAP_S if piece.ends_paragraph else SENTENCE_GAP_S
                pieces.append(_silence(gap, audio.sample_rate))

        chunk = _join(pieces)
        # "hit" only when nothing had to be synthesized. A partially cached
        # preview is not instant, and saying otherwise would make the label
        # untrustworthy for the one thing it is for.
        cached = hits == len(chunks)
    except (BackendUnavailable, NotImplementedError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TTSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    wav = to_wav_bytes(chunk)
    if request.format == "mp4":
        return Response(
            content=audio_to_mp4(wav),
            media_type="video/mp4",
            headers={
                "Cache-Control": "no-store",
                "X-Audio-Duration": f"{chunk.duration_s:.2f}",
                "X-Cache": "hit" if cached else "miss",
                "Content-Disposition": (
                    f'inline; filename="{_download_name(spec, voice, request.speed, "mp4")}"'
                ),
            },
        )

    filename = _download_name(spec, voice, request.speed)
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            # The audio is cached server-side by content; letting the browser
            # cache the *response* as well would only mean a stale preview
            # after a clip is re-uploaded under the same name.
            "Cache-Control": "no-store",
            "X-Audio-Duration": f"{chunk.duration_s:.2f}",
            "X-Cache": "hit" if cached else "miss",
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )
