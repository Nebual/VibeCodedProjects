/**
 * Y-axis labels drawn from the readings themselves.
 *
 * A "nice" tick scale (or the padded min/max the chart happens to span) puts
 * numbers on the axis that nobody ever weighed — 81.37, 83.12 — which read as
 * noise. Labelling actual measured values instead means every number on the
 * axis is one you can find on the line.
 *
 * Which readings get a label: the latest (the one you care about), then the
 * highest and lowest, then farthest-point-first — each pick is the reading
 * furthest from every label already placed — until the next one would sit
 * closer than `minGap` to a neighbour. That samples evenly across the range
 * instead of bunching wherever readings cluster, and shows every reading when
 * there's room.
 *
 * Values are compared after rounding to `decimals`, so 80.04 and 80.01 are one
 * label ("80"), not two identical-looking ones.
 */
export function pickAxisValues(
  values: number[],
  /** Maps a value to its vertical position, in any unit `minGap` shares. */
  position: (value: number) => number,
  minGap: number,
  decimals = 1,
): number[] {
  if (!values.length) return []
  const round = (v: number) => Number(v.toFixed(decimals))
  const candidates = [...new Set(values.map(round))]

  const picked: number[] = []
  const distance = (v: number) =>
    picked.length
      ? Math.min(...picked.map((p) => Math.abs(position(p) - position(v))))
      : Infinity
  const tryPick = (v: number) => {
    if (!picked.includes(v) && distance(v) >= minGap) picked.push(v)
  }

  tryPick(round(values[values.length - 1]!))
  tryPick(Math.max(...candidates))
  tryPick(Math.min(...candidates))

  for (;;) {
    let best: number | null = null
    let bestDistance = -1
    for (const v of candidates) {
      if (picked.includes(v)) continue
      const d = distance(v)
      if (d > bestDistance) {
        best = v
        bestDistance = d
      }
    }
    if (best === null || bestDistance < minGap) break
    picked.push(best)
  }

  return picked.sort((a, b) => b - a)
}
