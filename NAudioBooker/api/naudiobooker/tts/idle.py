"""Unload an idle model so its VRAM goes back to the card.

An 8 GB card cannot hold Chatterbox and OmniVoice at once, and both nodes stay
running so either can answer at any moment. Without this, whichever model was
used first keeps its allocation forever and the second node fails to load with
an out-of-memory error that says nothing about the real cause.

Sixty seconds is deliberately short. Reloading costs a few seconds; discovering
that the other model cannot start costs a failed render.
"""

from __future__ import annotations

import logging
import threading

from .base import backend_idle_seconds, unload_backend

log = logging.getLogger(__name__)

#: How often to check. Fine-grained enough that the unload lands close to the
#: deadline, coarse enough to be invisible.
CHECK_INTERVAL_S = 5.0


class IdleUnloader:
    """Background thread that unloads a backend after a period of inactivity."""

    def __init__(self, backend: object, idle_after_s: float) -> None:
        self._backend = backend
        self._idle_after_s = idle_after_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._idle_after_s <= 0:
            log.info("idle unloading disabled")
            return
        self._thread = threading.Thread(
            target=self._run, name="idle-unloader", daemon=True
        )
        self._thread.start()
        log.info("will unload the model after %.0fs idle", self._idle_after_s)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _run(self) -> None:
        while not self._stop.wait(CHECK_INTERVAL_S):
            try:
                idle = backend_idle_seconds(self._backend)
            except Exception:  # pragma: no cover - a probe must never crash us
                continue
            if idle is None or idle < self._idle_after_s:
                continue
            try:
                if unload_backend(self._backend):
                    log.info("unloaded the model after %.0fs idle", idle)
            except Exception:
                log.exception("failed to unload the idle model")
