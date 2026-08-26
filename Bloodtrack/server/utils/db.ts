import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { League, Match, Player, Report } from '../../shared/types'

let _db: DatabaseSync | undefined

function dbPath(): string {
  return process.env.BLOODTRACK_DB ?? join(process.cwd(), 'data', 'bloodtrack.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leagues (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id        TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  name      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  league_id   TEXT NOT NULL REFERENCES leagues(id),
  round       INTEGER NOT NULL,
  player_a_id TEXT NOT NULL,
  player_b_id TEXT NOT NULL,
  date        TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  match_id     TEXT PRIMARY KEY REFERENCES matches(id),
  reporter_id  TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('A_WIN','B_WIN','DRAW')),
  touchdowns_a INTEGER NOT NULL DEFAULT 0,
  touchdowns_b INTEGER NOT NULL DEFAULT 0,
  casualties_a INTEGER NOT NULL DEFAULT 0,
  casualties_b INTEGER NOT NULL DEFAULT 0
);
`

export function db(): DatabaseSync {
  if (!_db) {
    const path = dbPath()
    mkdirSync(dirname(path), { recursive: true })
    _db = new DatabaseSync(path)
    _db.exec('PRAGMA foreign_keys = ON')
    _db.exec(SCHEMA)
  }
  return _db
}

/** Test-only: reset the cached connection. */
export function _resetDb(): void {
  _db = undefined
}

function id(): string {
  return crypto.randomUUID()
}

// --- reads ---

export function createLeague(name: string): League {
  const league: League = { id: id(), name, players: [], matches: [] }
  db()
    .prepare('INSERT INTO leagues (id, name) VALUES (?, ?)')
    .run(league.id, league.name)
  return league
}

export function listLeagues(): Pick<League, 'id' | 'name' | 'players'>[] {
  const leagues = db().prepare('SELECT id, name FROM leagues ORDER BY rowid').all() as {
    id: string
    name: string
  }[]
  const playersStmt = db().prepare('SELECT id, name FROM players WHERE league_id = ?')
  return leagues.map((l) => ({
    ...l,
    players: playersStmt.all(l.id) as Player[],
  }))
}

function toMatch(row: {
  id: string
  round: number
  player_a_id: string
  player_b_id: string
  date: string | null
  reporter_id?: string
  result?: string
  touchdowns_a?: number
  touchdowns_b?: number
  casualties_a?: number
  casualties_b?: number
}): Match {
  const m: Match = {
    id: row.id,
    round: row.round,
    playerAId: row.player_a_id,
    playerBId: row.player_b_id,
  }
  if (row.date !== null && row.date !== undefined) m.date = row.date
  if (row.result !== undefined && row.result !== null && row.reporter_id !== undefined) {
    m.reported = {
      reporterId: row.reporter_id,
      result: row.result as Report['result'],
      touchdownsA: row.touchdowns_a!,
      touchdownsB: row.touchdowns_b!,
      casualtiesA: row.casualties_a!,
      casualtiesB: row.casualties_b!,
    }
  }
  return m
}

const MATCH_SELECT = `
  SELECT m.id, m.round, m.player_a_id, m.player_b_id, m.date, m.league_id,
         r.reporter_id, r.result, r.touchdowns_a, r.touchdowns_b,
         r.casualties_a, r.casualties_b
  FROM matches m
  LEFT JOIN reports r ON r.match_id = m.id
`

export function getLeague(leagueId: string): League | undefined {
  const row = db().prepare('SELECT id, name FROM leagues WHERE id = ?').get(leagueId) as
    | { id: string; name: string }
    | undefined
  if (!row) return undefined
  const matchRows = db()
    .prepare(`${MATCH_SELECT} WHERE m.league_id = ? ORDER BY m.rowid`)
    .all(leagueId) as Parameters<typeof toMatch>[0][]
  return { id: row.id, name: row.name, players: getPlayers(leagueId), matches: matchRows.map(toMatch) }
}

export function getPlayers(leagueId: string): Player[] {
  return db().prepare('SELECT id, name FROM players WHERE league_id = ? ORDER BY rowid').all(leagueId) as Player[]
}

export function addPlayer(leagueId: string, name: string): Player {
  const league = db().prepare('SELECT id FROM leagues WHERE id = ?').get(leagueId)
  if (!league) throw new Error(`League ${leagueId} not found`)
  const player: Player = { id: id(), name }
  db().prepare('INSERT INTO players (id, league_id, name) VALUES (?, ?, ?)').run(player.id, leagueId, player.name)
  return player
}

export function renamePlayer(leagueId: string, playerId: string, name: string): Player | undefined {
  const res = db().prepare('UPDATE players SET name = ? WHERE id = ? AND league_id = ?').run(name, playerId, leagueId)
  if (res.changes === 0) return undefined
  return { id: playerId, name }
}

/** Locate a match and its owning league without scanning every blob. */
export function findMatch(matchId: string): { match: Match; leagueId: string } | undefined {
  const row = db().prepare(`${MATCH_SELECT} WHERE m.id = ?`).get(matchId) as
    | (Parameters<typeof toMatch>[0] & { league_id: string })
    | undefined
  if (!row) return undefined
  const leagueId = (row as { league_id: string }).league_id
  // strip the extra key before conversion
  delete (row as Record<string, unknown>).league_id
  return { match: toMatch(row), leagueId }
}


export function getReport(matchId: string): Report | undefined {
  const row = db().prepare('SELECT * FROM reports WHERE match_id = ?').get(matchId) as
    | { reporter_id: string; result: string; touchdowns_a: number; touchdowns_b: number; casualties_a: number; casualties_b: number }
    | undefined
  if (!row) return undefined
  return {
    reporterId: row.reporter_id,
    result: row.result as Report['result'],
    touchdownsA: row.touchdowns_a,
    touchdownsB: row.touchdowns_b,
    casualtiesA: row.casualties_a,
    casualtiesB: row.casualties_b,
  }
}

export function updateMatchDate(matchId: string, date: string | null): void {
  db().prepare('UPDATE matches SET date = ? WHERE id = ?').run(date, matchId)
}

export function upsertReport(matchId: string, report: Report): void {
  db()
    .prepare(
      `INSERT INTO reports (match_id, reporter_id, result, touchdowns_a, touchdowns_b, casualties_a, casualties_b)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET
         reporter_id = excluded.reporter_id,
         result = excluded.result,
         touchdowns_a = excluded.touchdowns_a,
         touchdowns_b = excluded.touchdowns_b,
         casualties_a = excluded.casualties_a,
         casualties_b = excluded.casualties_b`,
    )
    .run(
      matchId,
      report.reporterId,
      report.result,
      report.touchdownsA,
      report.touchdownsB,
      report.casualtiesA,
      report.casualtiesB,
    )
}

/** Insert many matches in one transaction (schedule generation). */
export function insertMatches(leagueId: string, matches: Match[]): void {
  if (!matches.length) return
  const d = db()
  d.exec('BEGIN')
  try {
    const stmt = d.prepare(
      'INSERT INTO matches (id, league_id, round, player_a_id, player_b_id, date) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const m of matches) {
      stmt.run(m.id, leagueId, m.round, m.playerAId, m.playerBId, m.date ?? null)
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}
