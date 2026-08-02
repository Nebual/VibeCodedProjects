"""The remote synthesiser node.

This is the entire surface a GPU box exposes: turn text into audio. No book
state, no database, no filesystem beyond the model weights. That narrowness is
deliberate -- it means the node can be restarted, moved or lost without
affecting a render in progress beyond a fallback to local CPU.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response

from ..audio import to_wav_bytes
from ..config import get_settings
from ..models import NodeInfo, PreviewRequest
from ..tts import BackendUnavailable, TTSError, get_backend

router = APIRouter(tags=["node"])


def _check_token(authorization: str | None) -> None:
    """Shared-secret auth.

    The node runs on a LAN and will happily burn GPU time for anyone who can
    reach it, so a token is required whenever one is configured. Leaving it
    unset is allowed for a trusted network, but the node says so in /health
    rather than pretending to be secured.
    """
    expected = get_settings().remote_worker_token
    if not expected:
        return

    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if supplied != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing node token")


@router.get("/node/health", response_model=NodeInfo)
def node_health() -> NodeInfo:
    """Identity and readiness.

    ``model_version`` is the important field: the client adopts it as part of
    its cache key, so audio synthesized here is interchangeable with audio made
    locally only when the two genuinely match.
    """
    settings = get_settings()
    try:
        backend = get_backend(settings)
        health = backend.health()
        return NodeInfo(
            available=health.available,
            detail=health.detail,
            backend=backend.id,
            model_version=backend.model_version,
            sample_rate=backend.sample_rate,
            max_chars=backend.max_chars,
            authenticated=bool(settings.remote_worker_token),
        )
    except (BackendUnavailable, NotImplementedError) as exc:
        return NodeInfo(
            available=False,
            detail=str(exc),
            backend=settings.tts_backend,
            model_version="unknown",
            sample_rate=0,
            max_chars=0,
            authenticated=bool(settings.remote_worker_token),
        )


@router.post(
    "/node/synthesize",
    responses={200: {"content": {"audio/wav": {}}, "description": "WAV audio"}},
)
def node_synthesize(
    request: PreviewRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    _check_token(authorization)

    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text supplied")

    try:
        backend = get_backend()
        chunk = backend.synthesize(text, request.voice, request.speed)
    except (BackendUnavailable, NotImplementedError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TTSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 16-bit WAV rather than raw float32: it halves what crosses the network
    # and matches what the cache stores anyway, so nothing extra is lost.
    return Response(
        content=to_wav_bytes(chunk),
        media_type="audio/wav",
        headers={"X-Audio-Duration": f"{chunk.duration_s:.3f}"},
    )
