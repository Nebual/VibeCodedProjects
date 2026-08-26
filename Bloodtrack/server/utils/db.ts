import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { League, Player } from '../../shared/types'

let _db: DatabaseSync | undefined

function dbPath(): string {
  return process.env.BLOODTRACK_DB ?? join(process.cwd(), 'data', 'bloodtrack.db')
}

export function db(): DatabaseSync {
  if (!_db) {
    const path = dbPath()
    mkdirSync(dirname(path), { recursive: true })
    _db = new DatabaseSync(path)
    _db.exec(
      'CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, json TEXT NOT NULL)',
    )
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

export function createLeague(name: string): League {
  const league: League = { id: id(), name, players: [], matches: [] }
  saveLeague(league)
  return league
}

export function listLeagues(): Pick<League, 'id' | 'name' | 'players'>[] {
  const rows = db().prepare('SELECT json FROM leagues ORDER BY rowid').all() as {
    json: string
  }[]
  return rows.map((r) => {
    const l = JSON.parse(r.json) as League
    return { id: l.id, name: l.name, players: l.players }
  })
}

export function getLeague(leagueId: string): League | undefined {
  const row = db().prepare('SELECT json FROM leagues WHERE id = ?').get(leagueId) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(row.json) as League) : undefined
}

export function saveLeague(league: League): void {
  db()
    .prepare(
      'INSERT INTO leagues (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
    )
    .run(league.id, JSON.stringify(league))
}

export function addPlayer(leagueId: string, name: string): Player {
  const league = getLeague(leagueId)
  if (!league) throw new Error(`League ${leagueId} not found`)
  const player: Player = { id: id(), name }
  league.players.push(player)
  saveLeague(league)
  return player
}
