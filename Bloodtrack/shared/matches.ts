import type { League, Match, Player } from '~~/shared/types'

export type MatchView = {
  id: string
  round: number
  date?: string
  reported: boolean
  playerA: Player
  playerB: Player
  result?: string
  touchdownsA?: number
  touchdownsB?: number
  casualtiesA?: number
  casualtiesB?: number
}

function playerName(league: League, id: string): Player {
  return league.players.find((p) => p.id === id) ?? { id, name: 'Unknown' }
}

/**
 * All matches in a round, ordered by date (undated last), for everyone in the league.
 */
export function listRoundMatches(
  league: League,
  round?: number,
): MatchView[] {
  const matches =
    round === undefined ? league.matches : league.matches.filter((m) => m.round === round)
  return matches
    .map((m) => toView(m, league))
    .sort((a, b) => {
      // undated matches sort after dated ones; ties keep round order stable by id
      if (!a.date && !b.date) return a.id < b.id ? -1 : 1
      if (!a.date) return 1
      if (!b.date) return -1
      return a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1)
    })
}

export function toView(m: Match, league: League): MatchView {
  return {
    id: m.id,
    round: m.round,
    date: m.date,
    reported: !!m.reported,
    playerA: playerName(league, m.playerAId),
    playerB: playerName(league, m.playerBId),
    result: m.reported?.result,
    touchdownsA: m.reported?.touchdownsA,
    touchdownsB: m.reported?.touchdownsB,
    casualtiesA: m.reported?.casualtiesA,
    casualtiesB: m.reported?.casualtiesB,
  }
}

/**
 * The "current" match = the match scheduled for today's date (server local).
 * Assumes one match per day. Returns undefined if none.
 */
export function findCurrentMatch(league: League, today: string): Match | undefined {
  return league.matches.find((m) => m.date === today)
}
