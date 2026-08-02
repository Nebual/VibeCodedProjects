"""Prefer the remote node; fall back to local CPU when it is not there.

The GPU box is a desktop that sleeps, reboots and gets unplugged. A render that
died because of that would be far worse than one that quietly finished slower,
so an unreachable node degrades rather than fails.

Falling back mid-job is safe because of the chunk cache: chunks already
synthesized stay valid, and the two backends only share cache entries when they
report the same ``model_version`` -- so a fallback never serves GPU-made audio
where CPU-made audio was expected, or the reverse.
"""

from __future__ import annotations

import logging
import time

from .base import (
    NO_OPTIONS,
    AudioChunk,
    BackendHealth,
    BackendUnavailable,
    ModelOptions,
    ReferenceClip,
    TTSBackend,
    Voice,
)

log = logging.getLogger(__name__)

#: How long to stop trying the node after it fails. Long enough not to stall
#: every chunk on a connection timeout, short enough that a box coming back
#: from sleep is picked up within a chapter or two.
RETRY_AFTER_S = 120.0


class FallbackBackend:
    """Routes to ``primary``, using ``secondary`` while the primary is down."""

    def __init__(
        self,
        primary: TTSBackend,
        secondary: TTSBackend,
        *,
        retry_after_s: float = RETRY_AFTER_S,
    ) -> None:
        self.primary = primary
        self.secondary = secondary
        self._retry_after_s = retry_after_s
        self._blocked_until = 0.0
        self._using_fallback = False

    # -- routing -----------------------------------------------------------

    @property
    def _primary_available(self) -> bool:
        return time.monotonic() >= self._blocked_until

    def _demote(self, exc: Exception) -> None:
        self._blocked_until = time.monotonic() + self._retry_after_s
        if not self._using_fallback:
            log.warning(
                "remote synthesis unavailable (%s); falling back to %s for %.0fs",
                exc,
                self.secondary.id,
                self._retry_after_s,
            )
        self._using_fallback = True

    def _promote(self) -> None:
        if self._using_fallback:
            log.info("remote synthesis is back; resuming on %s", self.primary.id)
        self._using_fallback = False
        self._blocked_until = 0.0

    def _active(self) -> TTSBackend:
        return self.secondary if self._using_fallback else self.primary

    # -- TTSBackend --------------------------------------------------------

    @property
    def id(self) -> str:
        return self._active().id

    @property
    def model_version(self) -> str:
        """Whichever backend will actually do the work.

        Deliberately not a merged or synthetic value: the cache key must name
        the model that produced the audio, so this has to change when routing
        changes.
        """
        return self._active().model_version

    @property
    def sample_rate(self) -> int:
        return self._active().sample_rate

    @property
    def max_chars(self) -> int:
        # The smaller of the two, so a chunk planned while on one backend is
        # still valid if the other takes over mid-chapter.
        try:
            return min(self.primary.max_chars, self.secondary.max_chars)
        except BackendUnavailable:
            return self.secondary.max_chars

    def voices(self) -> list[Voice]:
        if self._primary_available:
            try:
                return self.primary.voices()
            except BackendUnavailable as exc:
                self._demote(exc)
        return self.secondary.voices()

    def synthesize(
        self,
        text: str,
        voice: str,
        speed: float = 1.0,
        reference: ReferenceClip | None = None,
        options: ModelOptions = NO_OPTIONS,
    ) -> AudioChunk:
        if self._primary_available:
            try:
                chunk = self.primary.synthesize(text, voice, speed, reference, options)
                self._promote()
                return chunk
            except BackendUnavailable as exc:
                self._demote(exc)
            # A TTSError is the node working correctly and rejecting this
            # input; retrying locally would just fail the same way.

        return self.secondary.synthesize(text, voice, speed, reference, options)

    @property
    def provider(self) -> str | None:
        return getattr(self._active(), "provider", None)

    def health(self) -> BackendHealth:
        primary = self.primary.health() if self._primary_available else None
        if primary is not None and primary.available:
            self._promote()
            return BackendHealth(available=True, detail=f"remote: {primary.detail}")

        # Demote, do not merely report. Saying "using local fallback" while
        # leaving the dispatcher pointed at the primary makes `id` and
        # `model_version` describe a backend that is not serving -- and
        # model_version is part of the chunk cache key, so a disagreement there
        # is not just a confusing status line.
        if primary is not None:
            self._demote(RuntimeError(primary.detail))

        secondary = self.secondary.health()
        reason = primary.detail if primary else "remote in cooldown after a failure"
        return BackendHealth(
            available=secondary.available,
            detail=f"using local fallback ({reason})",
        )
