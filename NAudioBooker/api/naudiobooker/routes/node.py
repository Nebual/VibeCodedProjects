"""The remote synthesiser node.

This is the entire surface a GPU box exposes: turn text into audio. No book
state, no database, no filesystem beyond the model weights. That narrowness is
deliberate -- it means the node can be restarted, moved or lost without
affecting a render in progress beyond a fallback to local CPU.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response

from .. import node_clips
from ..audio import to_wav_bytes
from ..config import get_settings
from ..models import NodeInfo, NodeSynthesizeRequest
from ..tts import BackendUnavailable, TTSError, get_backend
from ..tts.base import BackendHealth, ModelOptions, ReferenceClip, unload_backend

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

        # Loads the model on first call. Worth the one-off second: without it
        # the answer to "is this node actually using the GPU?" is unknowable,
        # and that question is the whole reason the node exists.
        provider = None
        if health.available:
            try:
                provider = getattr(backend, "device", None)
            except BackendUnavailable as exc:
                health = BackendHealth(available=False, detail=str(exc))

        return NodeInfo(
            available=health.available,
            detail=health.detail,
            backend=backend.id,
            model_version=backend.model_version,
            sample_rate=backend.sample_rate,
            max_chars=backend.max_chars,
            provider=provider,
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


@router.post("/node/unload")
def node_unload(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """Release the model and its VRAM.

    Called by a peer node's client before it loads its own model. An 8 GB card
    cannot hold two of these at once, and the failure mode without this is an
    out-of-memory error on the second model that says nothing about the first
    one still holding the card.

    Safe to call when nothing is loaded; it simply reports that.
    """
    _check_token(authorization)
    try:
        backend = get_backend()
    except (BackendUnavailable, NotImplementedError):
        return {"unloaded": False, "detail": "no backend to unload"}

    freed = unload_backend(backend)
    return {
        "unloaded": freed,
        "detail": "model released" if freed else "nothing was loaded",
    }


@router.get("/node/clips/{ref_hash}")
def node_has_clip(
    ref_hash: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """Whether this node already holds a reference clip.

    Asked once per clip so the primary can skip the upload. A book is twenty
    thousand chunks; re-sending the clip with each one would move gigabytes to
    convey the same few hundred kilobytes.
    """
    _check_token(authorization)
    return {"ref_hash": ref_hash, "present": node_clips.has(ref_hash)}


@router.post("/node/clips/{ref_hash}", status_code=201)
async def node_put_clip(
    ref_hash: str,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """Accept a reference clip, verified against the hash it is filed under."""
    _check_token(authorization)

    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty clip")

    try:
        node_clips.store(ref_hash, data)
    except node_clips.ClipRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"ref_hash": ref_hash, "stored": True}


@router.post(
    "/node/synthesize",
    responses={200: {"content": {"audio/wav": {}}, "description": "WAV audio"}},
)
def node_synthesize(
    request: NodeSynthesizeRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    _check_token(authorization)

    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text supplied")

    reference = None
    if request.voice_ref:
        if not node_clips.has(request.voice_ref):
            # 409 rather than 400: the caller can fix this by uploading the
            # clip and retrying, which is exactly what the client does.
            raise HTTPException(
                status_code=409,
                detail=f"reference clip {request.voice_ref[:12]} is not on this node",
            )
        reference = ReferenceClip(
            path=node_clips.path_for(request.voice_ref),
            ref_hash=request.voice_ref,
            transcript=request.ref_text,
        )

    try:
        backend = get_backend()
        chunk = backend.synthesize(
            text,
            request.voice,
            request.speed,
            reference,
            ModelOptions.from_dict(request.options),
        )
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
