const ANALYSIS_SAMPLE_RATE = 8000 // envelope detection doesn't need full fidelity
const WINDOW_S = 0.1 // matches BUCKET_RATE used elsewhere for waveform display
const WINDOW_SAMPLES = Math.round(ANALYSIS_SAMPLE_RATE * WINDOW_S)
const FLOOR_WINDOW_S = 0.5 // the quietest floor is measured over ~0.5s stretches, not single 100ms blips
const FLOOR_REGION_S = 15 // how much of the start/end to search for that region's floor — recording habits, not piece length
// Low, not "typical quiet" — the true silent lead-in/tail is often a small fraction of the search
// region (loud music can dominate most of it), so the percentile has to be low enough to still land
// inside that fraction. A low estimate is also the safer failure mode: it errs toward under-cutting
// (leaving a little extra silence) rather than clipping into real content.
const FLOOR_PERCENTILE = 0.05
const SMOOTH_WINDOWS = 3 // ~0.3s smoothing so a single noisy sample doesn't fake "still decaying"
const MIN_SUSTAIN_WINDOWS = 10 // 1s — a brief handling click/thud shouldn't count as "still playing";
// a genuinely held final chord (the case this exists for) sustains far longer than that anyway.

export interface AutoTrimProposal {
  /** Seconds to cut from the start. */
  startCut: number
  /** Seconds to cut from the end (from the end of the file, not an absolute position). */
  endCut: number
  noiseFloorDb: number
  tailPadS: number
  fadeOutMs: number
}

function rmsWindows(samples: Int16Array): number[] {
  const windows: number[] = []
  for (let start = 0; start < samples.length; start += WINDOW_SAMPLES) {
    const end = Math.min(samples.length, start + WINDOW_SAMPLES)
    let sumSquares = 0
    for (let i = start; i < end; i++) {
      const v = samples[i]! / 32768
      sumSquares += v * v
    }
    windows.push(Math.sqrt(sumSquares / (end - start)))
  }
  return windows
}

function rollingAverage(values: number[], windowCount: number): number[] {
  if (values.length < windowCount) return [values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)]
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= windowCount) sum -= values[i - windowCount]!
    if (i >= windowCount - 1) out.push(sum / windowCount)
  }
  return out
}

/**
 * A robust "quiet floor" within [from, to): the FLOOR_PERCENTILE-th quietest
 * of the rolling ~1s averages in that stretch. A percentile rather than the
 * strict minimum, so one anomalously-dead moment (an encoder gap, a perfectly
 * silent instant) can't drag the whole threshold down and make everything
 * else look "loud" by comparison.
 */
function localFloor(windows: number[], from: number, to: number): number {
  const floorWindowCount = Math.max(1, Math.round(FLOOR_WINDOW_S / WINDOW_S))
  const slice = windows.slice(Math.max(0, from), Math.min(windows.length, to))
  if (slice.length === 0) return 1e-6
  const rolling = [...rollingAverage(slice, floorWindowCount)].sort((a, b) => a - b)
  const idx = Math.min(rolling.length - 1, Math.max(0, Math.floor(FLOOR_PERCENTILE * (rolling.length - 1))))
  return Math.max(rolling[idx]!, 1e-6)
}

function linearToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -100
}

/** Index of the start of the first run of >= minRun consecutive above-threshold values, or -1. */
function firstSustainedAbove(values: number[], threshold: number, minRun: number): number {
  let runStart = -1
  for (let i = 0; i < values.length; i++) {
    if (values[i]! > threshold) {
      if (runStart === -1) runStart = i
      if (i - runStart + 1 >= minRun) return runStart
    } else {
      runStart = -1
    }
  }
  return -1
}

/**
 * Index of the END of the LAST run of >= minRun consecutive above-threshold
 * values, or -1. A single blip after the true last sustained sound (a click
 * when the recording was stopped, a decode artifact) never reaches minRun,
 * so it can't drag this later than the genuine last sustained content.
 */
function lastSustainedAbove(values: number[], threshold: number, minRun: number): number {
  let bestEnd = -1
  let runStart = -1
  for (let i = 0; i < values.length; i++) {
    if (values[i]! > threshold) {
      if (runStart === -1) runStart = i
      if (i - runStart + 1 >= minRun) bestEnd = i
    } else {
      runStart = -1
    }
  }
  return bestEnd
}

/**
 * Threshold-relative (not a fixed dB) start/end trim proposal. The noise
 * floor is measured separately near the start and near the end — from the
 * quietest contiguous ~1s stretch in that region — rather than one global
 * floor for the whole piece, since a global floor gets skewed by quiet
 * musical passages elsewhere and misjudges both ends. The end cut walks the
 * decay of the final notes on a smoothed envelope rather than gating hard at
 * the threshold, so a long held chord survives — cutting once the envelope
 * stops falling, not the instant it crosses -6dB.
 */
export function analyzeAutoTrim(samples: Int16Array, durationS: number): AutoTrimProposal {
  const windows = rmsWindows(samples)
  const tailPadS = 1.5
  const fadeOutMs = 1200

  if (windows.length === 0) {
    return { startCut: 0, endCut: 0, noiseFloorDb: -100, tailPadS, fadeOutMs }
  }

  const regionLen = Math.max(1, Math.round(FLOOR_REGION_S / WINDOW_S))
  const startFloor = localFloor(windows, 0, regionLen)
  const endFloor = localFloor(windows, windows.length - regionLen, windows.length)
  const startThreshold = startFloor * 2 // +6dB over the measured floor
  const endThreshold = endFloor * 2

  // Threshold crossings are detected on a smoothed envelope, not raw 100ms
  // windows — a single-window blip (a handling click when the recording was
  // stopped, a decode artifact) would otherwise look identical to genuine
  // sustained sound and defeat the whole "last loud moment" search.
  const smoothWindowCount = Math.max(1, SMOOTH_WINDOWS)
  const smoothed = rollingAverage(windows, smoothWindowCount)
  const smoothIndexToTime = (i: number) => (i + smoothWindowCount - 1) * WINDOW_S

  let firstLoud = firstSustainedAbove(smoothed, startThreshold, MIN_SUSTAIN_WINDOWS)
  if (firstLoud === -1) firstLoud = 0
  const startCut = Math.max(0, smoothIndexToTime(firstLoud) - 0.2)

  let lastLoud = lastSustainedAbove(smoothed, endThreshold, MIN_SUSTAIN_WINDOWS)
  if (lastLoud === -1) lastLoud = smoothed.length - 1

  // Walk forward from the last loud (smoothed) window while the envelope is
  // still falling — a decaying piano chord keeps dropping in level for
  // seconds after it crosses the threshold; only stop once it flattens.
  // Once the level actually reaches the noise floor, the floor's own
  // micro-fluctuations can look like "still falling" one window at a time
  // forever, so that check only applies above a margin over the floor —
  // reaching the floor itself always ends the walk.
  let decayEnd = lastLoud
  const maxWalkWindows = Math.round(15 / WINDOW_S) // don't chase decay forever
  const floorMargin = endFloor * 1.5 // ~+3.5dB — "close enough to the floor to call it done"
  for (let i = lastLoud; i < Math.min(smoothed.length - 1, lastLoud + maxWalkWindows); i++) {
    const current = smoothed[i]!
    const reachedFloor = current <= floorMargin
    const stillFalling = !reachedFloor && smoothed[i + 1]! < current * 0.98
    if (!stillFalling) {
      decayEnd = i
      break
    }
    decayEnd = i + 1
  }

  const decayEndS = smoothIndexToTime(decayEnd)
  const endCut = Math.max(0, durationS - Math.min(durationS, decayEndS + tailPadS))

  return {
    startCut,
    endCut,
    noiseFloorDb: linearToDb(endFloor),
    tailPadS,
    fadeOutMs,
  }
}
