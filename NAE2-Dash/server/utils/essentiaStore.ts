/**
 * Name-keyed amounts — the shape of essentia stock, item stock, and the sparse
 * per-name target thresholds alike: { "Ignis": 400 }.
 */
export type TargetMap = Record<string, number>

export type TargetKind = 'minimums' | 'maximums'

export interface EssentiaLimits {
  /** How many distinct aspects the storage can hold at once. */
  maxEssentiaTypes: number
  /** Total essentia the storage can hold across all aspects. */
  maxEssentiaAmount: number
}

interface StoredSnapshot extends EssentiaLimits {
  essentia: TargetMap
  /** Item stock. Shares the target maps below with essentia. */
  items: TargetMap
  minimums: TargetMap
  maximums: TargetMap
  updatedAt: number | null
}

export interface EssentiaSnapshot extends StoredSnapshot {
  /** True while the server will still take minimums/maximums from an external report. */
  acceptingTargets: boolean
}

export interface EssentiaReport {
  /** Omitted when the caller is only reporting limits or targets. */
  essentia?: TargetMap
  items?: TargetMap
  maxEssentiaTypes?: number
  maxEssentiaAmount?: number
  minimums?: TargetMap
  maximums?: TargetMap
}

type Listener = (snapshot: EssentiaSnapshot) => void

// Single in-memory snapshot of "what's currently in stock", plus the set of
// connected dashboards listening for changes to it.
const snapshot: StoredSnapshot = {
  essentia: {},
  items: {},
  minimums: {},
  maximums: {},
  updatedAt: null,
  maxEssentiaTypes: 48,
  maxEssentiaAmount: 32768,
}

/**
 * Targets are seeded once from whatever the external reporter first sends, and
 * from then on this server owns them — later reports no longer overwrite edits
 * made from the dashboard.
 */
const seeded: Record<TargetKind, boolean> = { minimums: false, maximums: false }

const listeners = new Set<Listener>()

export function getEssentia(): EssentiaSnapshot {
  return { ...snapshot, acceptingTargets: !seeded.minimums || !seeded.maximums }
}

export function getTargets(): Pick<EssentiaSnapshot, TargetKind> {
  return { minimums: { ...snapshot.minimums }, maximums: { ...snapshot.maximums } }
}

/** Aspect names arrive with inconsistent casing, so match existing keys loosely. */
function resolveKey(map: TargetMap, name: string): string {
  const lower = name.toLowerCase()
  return Object.keys(map).find(key => key.toLowerCase() === lower) ?? name
}

function broadcast(): EssentiaSnapshot {
  const next = getEssentia()
  for (const listener of listeners) {
    listener(next)
  }
  return next
}

export function applyReport(report: EssentiaReport): EssentiaSnapshot {
  // Every field is optional, so a partial report leaves the rest of the
  // snapshot alone rather than blanking it.
  if (report.essentia !== undefined) {
    snapshot.essentia = report.essentia
  }
  if (report.items !== undefined) {
    snapshot.items = report.items
  }
  snapshot.updatedAt = Date.now()

  // Limits are sticky: a report that omits them keeps whatever was last set.
  if (report.maxEssentiaTypes !== undefined) {
    snapshot.maxEssentiaTypes = report.maxEssentiaTypes
  }
  if (report.maxEssentiaAmount !== undefined) {
    snapshot.maxEssentiaAmount = report.maxEssentiaAmount
  }

  for (const kind of ['minimums', 'maximums'] as const) {
    const incoming = report[kind]
    if (incoming && !seeded[kind]) {
      snapshot[kind] = { ...incoming }
      seeded[kind] = true
    }
  }

  return broadcast()
}

/** Set one aspect's target, or clear it by passing null. */
export function setTarget(name: string, kind: TargetKind, value: number | null): EssentiaSnapshot {
  const map = snapshot[kind]
  const key = resolveKey(map, name)

  if (value === null) {
    delete map[key]
  } else {
    map[key] = value
  }
  // A dashboard edit counts as this server owning the targets from now on.
  seeded[kind] = true

  return broadcast()
}

/**
 * Hand ownership of the targets back to the external reporter: the next report
 * that includes minimums/maximums replaces whatever is stored here.
 */
export function resetTargetSeeding(): EssentiaSnapshot {
  seeded.minimums = false
  seeded.maximums = false
  return broadcast()
}

export function onEssentiaChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
