/**
 * Choosing between a GPU transcription sidecar and the CPU one.
 *
 * Deliberately free of Nitro auto-imports so it can be unit-tested without a server: the decision
 * logic is the part worth testing, and a GPU can't be stood up in CI anyway.
 *
 * The policy, from plans/AUDIO_TO_MIDI_PLAN_V2.md Stage 7: probe the GPU's `/health`, cache the
 * verdict briefly, and use the GPU when it answers. There is no re-queueing — transcription is
 * idempotent and cheap to re-request, so a job that dies mid-stream surfaces as an error the user
 * can retry, and the machinery to hide that failure would cost more than the failure does.
 */

export type WorkerTierName = 'cpu' | 'gpu'

export interface WorkerTarget {
  url: string
  /** Part of the transcription spec hash, so a result from one tier never masquerades as the other. */
  model: string
  tier: WorkerTierName
}

/** How long a health verdict is trusted before probing again. */
export const HEALTH_TTL_MS = 30_000
/** A GPU box that can't answer this fast is not worth waiting on when a CPU worker is right there. */
export const HEALTH_TIMEOUT_MS = 1_500

export function pickTarget(
  cpu: WorkerTarget,
  gpu: WorkerTarget | null,
  gpuIsHealthy: boolean,
): WorkerTarget {
  return gpu && gpuIsHealthy ? gpu : cpu
}

/**
 * Remembers whether the GPU answered, so a transcription doesn't pay for a probe every time.
 *
 * `now` is injectable purely so the expiry is testable without sleeping.
 */
export class HealthCache {
  private verdict: { healthy: boolean, at: number } | null = null

  constructor(private readonly ttlMs: number = HEALTH_TTL_MS) {}

  /** The remembered verdict, or null when there isn't a fresh one. */
  get(now: number): boolean | null {
    if (!this.verdict) return null
    if (now - this.verdict.at >= this.ttlMs) return null
    return this.verdict.healthy
  }

  set(healthy: boolean, now: number) {
    this.verdict = { healthy, at: now }
  }

  /**
   * Records a failure that happened *during* real work rather than during a probe.
   *
   * Marked as of `now` so the next request falls back to the CPU worker and the tier is retried
   * only after the normal TTL — a GPU that just dropped a job mid-stream should not be handed the
   * retry immediately.
   */
  markUnhealthy(now: number) {
    this.set(false, now)
  }

  reset() {
    this.verdict = null
  }
}
