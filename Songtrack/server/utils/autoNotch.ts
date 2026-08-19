/**
 * FFT-driven detection of tonal noise (mains hum, motor/fan whine) inside a
 * profiled noise region, so the NoisePanel can offer them as toggleable
 * notch-filter chips instead of the user hunting for frequencies by ear.
 *
 * A plain single-window FFT is noisy: broadband hiss creates spurious local
 * maxima that fluctuate window to window. Averaging the magnitude spectrum
 * across overlapping Hann-windowed frames (Welch's method) smooths that out,
 * leaving genuinely stationary tones standing well above their neighborhood.
 */

const FFT_SIZE = 8192 // power of 2; ~1Hz/bin at 8kHz sample rate, plenty to separate 50 vs 60Hz
const HOP = FFT_SIZE / 2

/** In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` length must be a power of 2. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len / 2
    for (let i = 0; i < n; i += len) {
      let curWr = 1
      let curWi = 0
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]!
        const uIm = im[i + j]!
        const tRe = re[i + j + half]! * curWr - im[i + j + half]! * curWi
        const tIm = re[i + j + half]! * curWi + im[i + j + half]! * curWr
        re[i + j] = uRe + tRe
        im[i + j] = uIm + tIm
        re[i + j + half] = uRe - tRe
        im[i + j + half] = uIm - tIm
        const nextWr = curWr * wr - curWi * wi
        const nextWi = curWr * wi + curWi * wr
        curWr = nextWr
        curWi = nextWi
      }
    }
  }
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const round1 = (hz: number) => Math.round(hz * 10) / 10
const toDb = (magnitude: number) => 20 * Math.log10(Math.max(magnitude, 1e-9))

export interface DetectNoiseTonesOptions {
  /** Cap on returned chips, so the panel doesn't drown in candidates. */
  maxCandidates?: number
  /** Fundamentals at or below this are assumed tonal (hum/whine) and get harmonics expanded. */
  harmonicFundamentalMaxHz?: number
  /** Ceiling for harmonic expansion. */
  harmonicMaxHz?: number
  /** How far above its local neighborhood (in dB) a bin must sit to count as a peak. */
  thresholdDb?: number
}

/**
 * Returns candidate notch frequencies (Hz), sorted ascending: detected
 * spectral peaks plus, for low fundamentals, their harmonics — e.g. a 50Hz
 * mains hum yields [50, 100, 150]. Returns [] if the region is too short to
 * analyze or nothing stands out above the noise floor.
 */
export function detectNoiseTones(samples: ArrayLike<number>, sampleRate: number, opts: DetectNoiseTonesOptions = {}): number[] {
  const maxCandidates = opts.maxCandidates ?? 8
  const harmonicFundamentalMaxHz = opts.harmonicFundamentalMaxHz ?? 130
  const harmonicMaxHz = opts.harmonicMaxHz ?? Math.min(1000, sampleRate / 2 - 10)
  const thresholdDb = opts.thresholdDb ?? 9

  if (samples.length < FFT_SIZE) return []

  const window = hannWindow(FFT_SIZE)
  const avgMag = new Float64Array(FFT_SIZE / 2)
  let frameCount = 0
  for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP) {
    const re = new Float64Array(FFT_SIZE)
    const im = new Float64Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) re[i] = (samples[start + i]! / 32768) * window[i]!
    fft(re, im)
    for (let k = 0; k < avgMag.length; k++) avgMag[k]! += Math.hypot(re[k]!, im[k]!)
    frameCount++
  }
  if (frameCount === 0) return []
  for (let k = 0; k < avgMag.length; k++) avgMag[k] = avgMag[k]! / frameCount

  const binHz = sampleRate / FFT_SIZE
  const minBin = Math.max(1, Math.floor(20 / binHz)) // below this is rumble; highpass already handles it
  const maxBin = Math.min(avgMag.length - 2, Math.floor((sampleRate / 2 - binHz) / binHz))
  const neighborhoodBins = Math.max(4, Math.round(50 / binHz))

  interface Peak { freq: number, prominence: number }
  const peaks: Peak[] = []
  for (let k = minBin; k <= maxBin; k++) {
    const v = avgMag[k]!
    if (v <= avgMag[k - 1]! || v <= avgMag[k + 1]!) continue // local maximum only
    const lo = Math.max(minBin, k - neighborhoodBins)
    const hi = Math.min(maxBin, k + neighborhoodBins)
    const baseline = median(Array.from(avgMag.slice(lo, hi + 1)))
    const prominence = toDb(v) - toDb(baseline)
    if (prominence >= thresholdDb) peaks.push({ freq: k * binHz, prominence })
  }
  peaks.sort((a, b) => b.prominence - a.prominence)

  const candidates: number[] = []
  const tolerance = Math.max(2, binHz * 2)
  const isNear = (f: number) => candidates.some(c => Math.abs(c - f) < tolerance)

  for (const peak of peaks) {
    if (candidates.length >= maxCandidates) break
    if (isNear(peak.freq)) continue
    candidates.push(round1(peak.freq))
    if (peak.freq <= harmonicFundamentalMaxHz) {
      for (let n = 2; candidates.length < maxCandidates; n++) {
        const harmonic = peak.freq * n
        if (harmonic > harmonicMaxHz) break
        if (!isNear(harmonic)) candidates.push(round1(harmonic))
      }
    }
  }

  return candidates.sort((a, b) => a - b)
}
