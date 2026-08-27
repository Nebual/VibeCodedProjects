import { describe, expect, it } from 'vitest'
import { HealthCache, pickTarget } from '../../server/utils/workerTier'
import type { WorkerTarget } from '../../server/utils/workerTier'

const CPU: WorkerTarget = { url: 'http://midi:8000', model: 'medium', tier: 'cpu' }
const GPU: WorkerTarget = { url: 'http://midi-gpu:8000', model: 'large', tier: 'gpu' }

describe('pickTarget', () => {
  it('uses the GPU when it is answering', () => {
    expect(pickTarget(CPU, GPU, true)).toBe(GPU)
  })

  it('falls back to the CPU when the GPU is not answering', () => {
    expect(pickTarget(CPU, GPU, false)).toBe(CPU)
  })

  it('uses the CPU when no GPU is configured at all', () => {
    expect(pickTarget(CPU, null, true)).toBe(CPU)
  })

  it('keeps the tiers on distinct models, so a result never masquerades as the other tier', () => {
    // The model is part of the transcription spec hash; sharing one would let a `large` result be
    // served from cache as though it came from `medium`.
    expect(GPU.model).not.toBe(CPU.model)
  })
})

describe('HealthCache', () => {
  it('has no verdict until one is recorded', () => {
    expect(new HealthCache().get(0)).toBeNull()
  })

  it('remembers a verdict for its TTL', () => {
    const cache = new HealthCache(30_000)
    cache.set(true, 1_000)
    expect(cache.get(1_000)).toBe(true)
    expect(cache.get(30_999)).toBe(true)
  })

  it('forgets a verdict once the TTL has passed, so a recovered GPU gets picked up', () => {
    const cache = new HealthCache(30_000)
    cache.set(false, 1_000)
    expect(cache.get(31_000)).toBeNull()
  })

  it('remembers an unhealthy verdict just as firmly as a healthy one', () => {
    const cache = new HealthCache(30_000)
    cache.set(false, 0)
    // Not null: a fresh "no" must stop the next request re-probing a box that just failed.
    expect(cache.get(1_000)).toBe(false)
  })

  it('markUnhealthy sends the next request to the CPU without an immediate retry', () => {
    const cache = new HealthCache(30_000)
    cache.set(true, 0)
    cache.markUnhealthy(5_000)
    expect(cache.get(5_001)).toBe(false)
    expect(pickTarget(CPU, GPU, cache.get(5_001)!)).toBe(CPU)
    // ...and the GPU is reconsidered only after the TTL, not on the very next job.
    expect(cache.get(36_000)).toBeNull()
  })

  it('reset clears the verdict', () => {
    const cache = new HealthCache()
    cache.set(true, 0)
    cache.reset()
    expect(cache.get(0)).toBeNull()
  })
})
