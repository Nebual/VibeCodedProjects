export type Player = { id: string; name: string }

export type MatchResult = 'A_WIN' | 'B_WIN' | 'DRAW'

export type Report = {
  reporterId: string
  result: MatchResult
  touchdownsA: number
  touchdownsB: number
  casualtiesA: number // casualties inflicted BY player A
  casualtiesB: number
}

export type Match = {
  id: string
  round: number
  playerAId: string
  playerBId: string
  /** Scheduled match date, ISO 'YYYY-MM-DD'. Optional until set by admin/player. */
  date?: string
  reported?: Report
}

export type League = {
  id: string
  name: string
  players: Player[]
  matches: Match[]
}

export type Standing = {
  playerId: string
  name: string
  played: number
  wins: number
  draws: number
  losses: number
  touchdowns: number
  casualties: number
  points: number
}
