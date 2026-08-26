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
