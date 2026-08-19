const STORAGE_KEY = 'songtrack:monitorTargetDb'
const DEFAULT_TARGET_DB = -18
const MIN_TARGET_DB = -30
const MAX_TARGET_DB = -6

function loadStoredTargetDb(): number {
  if (!import.meta.client) return DEFAULT_TARGET_DB
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return DEFAULT_TARGET_DB
  const stored = Number(raw)
  return Number.isFinite(stored) ? stored : DEFAULT_TARGET_DB
}

// Module-scope singletons (not useState) — this is a client-only monitoring
// preference that should be shared across every playback surface on a page,
// not per-component state, matching the pattern already used by usePlayer.ts.
const targetLevelDb = ref(loadStoredTargetDb())
let audioCtx: AudioContext | null = null
const gainNodes = new WeakMap<HTMLMediaElement, GainNode>()

if (import.meta.client) {
  watch(targetLevelDb, (db) => { localStorage.setItem(STORAGE_KEY, String(db)) })
}

function ensureAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

export function useMonitorGain() {
  /**
   * Wraps a media element's output through a GainNode, once per element
   * (an element can only ever be tapped by one MediaElementAudioSourceNode).
   * The element's audio is inaudible until this is called, since tapping it
   * routes its output exclusively through the returned graph.
   */
  function wrapElement(el: HTMLMediaElement): GainNode {
    const ctx = ensureAudioCtx()
    let node = gainNodes.get(el)
    if (!node) {
      const source = ctx.createMediaElementSource(el)
      node = ctx.createGain()
      source.connect(node)
      node.connect(ctx.destination)
      gainNodes.set(el, node)
    }
    return node
  }

  function targetRms(): number {
    return 10 ** (targetLevelDb.value / 20)
  }

  function gainForBuffer(buffer: AudioBuffer): number {
    return computeNormalizeGain(buffer, targetRms())
  }

  function gainForPeaks(peaks: Float32Array): number {
    return computeNormalizeGainFromPeaks(peaks, targetRms())
  }

  return {
    targetLevelDb,
    minTargetDb: MIN_TARGET_DB,
    maxTargetDb: MAX_TARGET_DB,
    ensureAudioCtx,
    wrapElement,
    gainForBuffer,
    gainForPeaks,
  }
}
