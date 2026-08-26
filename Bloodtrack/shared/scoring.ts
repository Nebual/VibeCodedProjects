import type { League, Player, Standing } from './types'

export type Pairing = { a: Player; b: Player; bye?: Player }

export function computeStandings(league: League): Standing[] {
  const table = new Map<string, Standing>()
  for (const p of league.players) {
    table.set(p.id, {
      playerId: p.id,
      name: p.name,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      touchdowns: 0,
      casualties: 0,
      points: 0,
    })
  }

  for (const match of league.matches) {
    if (!match.reported) continue
    const a = table.get(match.playerAId)
    const b = table.get(match.playerBId)
    if (!a || !b) continue
    const r = match.reported
    a.played++
    b.played++
    a.touchdowns += r.touchdownsA
    b.touchdowns += r.touchdownsB
    a.casualties += r.casualtiesA
    b.casualties += r.casualtiesB
    if (r.result === 'A_WIN') {
      a.wins++
      a.points += 3
      b.losses++
    } else if (r.result === 'B_WIN') {
      b.wins++
      b.points += 3
      a.losses++
    } else {
      a.draws++
      b.draws++
      a.points++
      b.points++
    }
  }

  return [...table.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.touchdowns - x.touchdowns ||
      y.casualties - x.casualties ||
      x.name.localeCompare(y.name),
  )
}

/**
 * Full round-robin schedule via the circle method: for N players this yields
 * N-1 rounds where every player faces every other player exactly once.
 * Odd player counts get a bye each round (the player paired with the ghost).
 */
export function generateRoundRobin(players: Player[]): Pairing[][] {
  const list = [...players]
  const hasGhost = list.length % 2 === 1
  if (hasGhost) list.push({ id: '__bye__', name: 'BYE' })
  const n = list.length
  const rounds: Pairing[][] = []

  for (let r = 0; r < n - 1; r++) {
    const pairings: Pairing[] = []
    for (let i = 0; i < n / 2; i++) {
      const a = list[i]
      const b = list[n - 1 - i]
      if (a.id === '__bye__') {
        pairings.push({ a: b, b: b, bye: b })
      } else if (b.id === '__bye__') {
        pairings.push({ a: a, b: a, bye: a })
      } else {
        // alternate home/away across rounds for variety
        pairings.push(r % 2 === 0 ? { a, b } : { a: b, b: a })
      }
    }
    rounds.push(pairings)
    // rotate: keep first fixed, rotate the rest
    const fixed = list[0]
    const rest = list.slice(1)
    rest.unshift(rest.pop()!)
    list.splice(0, list.length, fixed, ...rest)
  }
  return rounds
}

export function pairRound(players: Player[], excludeIds: Set<string> = new Set()): Pairing[] {
  const available = players.filter((p) => !excludeIds.has(p.id))
  const pairings: Pairing[] = []
  for (let i = 0; i + 1 < available.length; i += 2) {
    pairings.push({ a: available[i], b: available[i + 1] })
  }
  if (available.length % 2 === 1) {
    // attach bye to last pairing, or standalone if only one player
    const byePlayer = available[available.length - 1]
    if (pairings.length > 0) pairings[pairings.length - 1].bye = byePlayer
    else pairings.push({ a: byePlayer, b: byePlayer, bye: byePlayer })
  }
  return pairings
}
