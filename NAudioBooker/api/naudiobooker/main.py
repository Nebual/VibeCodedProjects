"""FastAPI application entrypoint."""

import logging
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from . import __version__
from .config import env_files_found, get_settings
from .db import init_db
from .routes import books_router, jobs_router, node_router, tts_router
from .schemas import HealthResponse, SystemDeps, TTSStatus
from .tts import get_backend

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    # A worker-node holds no book state, so it must not create the data tree
    # on the remote host.
    if settings.role != "worker-node":
        settings.ensure_dirs()
        init_db(settings.db_path)
    log.info(
        "naudiobooker %s starting (role=%s, tts=%s, env_files=%s)",
        __version__, settings.role, settings.tts_backend,
        env_files_found() or "none - using environment only",
    )
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="NAudioBooker API",
        version=__version__,
        lifespan=lifespan,
    )

    # The browser talks to Nuxt, which proxies here server-side, so CORS is
    # only needed when hitting the API directly during development.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if settings.role == "worker-node":
        # A node exposes synthesis and nothing else. Not mounting the book and
        # job routes is the enforcement, not just the intent: there is no way
        # to reach book state on a machine that never had any.
        app.include_router(node_router)
        app.include_router(tts_router)
    else:
        app.include_router(books_router)
        app.include_router(tts_router)
        app.include_router(jobs_router)
        app.include_router(node_router)

    def _tts_status() -> TTSStatus:
        """Probe the synthesis backend rather than echoing configuration.

        Reporting `settings.tts_backend` alone is worse than useless here: it
        says "remote" just as confidently when the node is unreachable and every
        chunk is quietly being synthesized on local CPU.
        """
        try:
            backend = get_backend(settings)
        except Exception as exc:
            return TTSStatus(
                configured=settings.tts_backend,
                available=False,
                detail=f"backend could not be created: {exc}",
            )

        try:
            health = backend.health()
        except Exception as exc:
            return TTSStatus(
                configured=settings.tts_backend,
                active=getattr(backend, "id", None),
                available=False,
                detail=str(exc),
            )

        return TTSStatus(
            configured=settings.tts_backend,
            # For the fallback dispatcher this is whichever backend is really
            # in use, which is the entire point of asking.
            active=getattr(backend, "id", None),
            available=health.available,
            detail=health.detail,
            provider=getattr(backend, "provider", None),
        )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        deps = SystemDeps(
            ffmpeg=shutil.which("ffmpeg") is not None,
            espeak_ng=shutil.which("espeak-ng") is not None,
        )
        # Off the event loop: a remote backend's health check is a network call.
        tts = await run_in_threadpool(_tts_status)
        healthy = deps.ffmpeg and deps.espeak_ng and tts.available
        return HealthResponse(
            status="ok" if healthy else "degraded",
            version=__version__,
            role=settings.role,
            tts_backend=settings.tts_backend,
            deps=deps,
            tts=tts,
            env_files=env_files_found(),
        )

    return app


app = create_app()
