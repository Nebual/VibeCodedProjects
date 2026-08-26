import { describe, expect, it } from 'vitest'
import { generateRoundRobin } from '../shared/scoring'
import type { Player } from '../shared/types'

function players(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }))
}

describe('generateRoundRobin', () => {
  it('produces N-1 rounds for even player counts', () => {
    expect(generateRoundRobin(players(8))).toHaveLength(7)
  })

  it('each round pairs everyone exactly once', () => {
    const rounds = generateRoundRobin(players(8))
    for (const round of rounds) {
      const ids = round.flatMap((p) => [p.a.id, p.b.id])
      expect(new Set(ids).size).toBe(8)
      // no byes in even leagues
      expect(round.every((p) => !p.bye)).toBe(true)
    }
  })

  it('every unordered matchup occurs exactly once across all rounds', () => {
    const rounds = generateRoundRobin(players(8))
    const seen = new Map<string, number>()
    for (const round of rounds) {
      for (const p of round) {
        const key = [p.a.id, p.b.id].sort().join('|')
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
    expect(seen.size).toBe((8 * 7) / 2) // C(8,2) = 28
    for (const count of seen.values()) expect(count).toBe(1)
  })

  it('works for odd counts with one bye per round', () => {
    const rounds = generateRoundRobin(players(5))
    expect(rounds).toHaveLength(5) // ghosted to 6 players -> 5 rounds
  })

  it('odd league: every real matchup occurs exactly once', () => {
    const rounds = generateRoundRobin(players(5))
    const seen = new Map<string, number>()
    let byeCounts = new Map<string, number>()
    for (const round of rounds) {
      const playing: string[] = []
      for (const p of round) {
        if (p.bye) {
          byeCounts.set(p.bye.id, (byeCounts.get(p.bye.id) ?? 0) + 1)
        } else {
          playing.push(p.a.id, p.b.id)
          const key = [p.a.id, p.b.id].sort().join('|')
          seen.set(key, (seen.get(key) ?? 0) + 1)
        }
      }
      expect(new Set(playing).size).toBe(playing.length)
    }
    expect(seen.size).toBe((5 * 4) / 2) // C(5,2) = 10
    for (const c of seen.values()) expect(c).toBe(1)
    // each player gets at most ceil diff byes; total byes = number of rounds
    const totalByes = [...byeCounts.values()].reduce((s, x) => s + x, 0)
    expect(totalByes).toBe(5)
  })
})
