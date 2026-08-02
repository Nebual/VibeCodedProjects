from .books import router as books_router
from .jobs import router as jobs_router
from .node import router as node_router
from .tts import router as tts_router
from .voices import router as voices_router

__all__ = [
    "books_router",
    "jobs_router",
    "node_router",
    "tts_router",
    "voices_router",
]
