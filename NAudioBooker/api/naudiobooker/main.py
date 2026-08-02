"""FastAPI application entrypoint."""

import logging
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .db import init_db
from .routes import books_router, jobs_router, node_router, tts_router
from .schemas import HealthResponse, SystemDeps

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    # A worker-node holds no book state, so it must not create the data tree
    # on the remote host.
    if settings.role != "worker-node":
        settings.ensure_dirs()
        init_db(settings.db_path)
    log.info("naudiobooker %s starting (role=%s)", __version__, settings.role)
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

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        deps = SystemDeps(
            ffmpeg=shutil.which("ffmpeg") is not None,
            espeak_ng=shutil.which("espeak-ng") is not None,
        )
        return HealthResponse(
            status="ok" if (deps.ffmpeg and deps.espeak_ng) else "degraded",
            version=__version__,
            role=settings.role,
            tts_backend=settings.tts_backend,
            deps=deps,
        )

    return app


app = create_app()
