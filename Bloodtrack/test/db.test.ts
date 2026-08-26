import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetDb,
  addPlayer,
  createLeague,
  findMatch,
  getLeague,
  getPlayers,
  insertMatches,
  listLeagues,
  renamePlayer,
  updateMatchDate,
  upsertReport,
} from '../server/utils/db'

let dir: string
let prevEnv: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bloodtrack-'))
  prevEnv = process.env.BLOODTRACK_DB
  process.env.BLOODTRACK_DB = join(dir, 'test.db')
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.BLOODTRACK_DB
  else process.env.BLOODTRACK_DB = prevEnv
  _resetDb()
})

describe('db', () => {
  it('creates a league and lists it', () => {
    const league = createLeague('My League')
    expect(league.name).toBe('My League')
    const listed = listLeagues()
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe('My League')
    expect(listed[0].players).toEqual([])
  })

  it('persists players across connections', () => {
    const league = createLeague('L2')
    addPlayer(league.id, 'Alice')
    addPlayer(league.id, 'Bob')
    _resetDb() // prove it lives on disk, not in a cache
    const loaded = getLeague(league.id)!
    expect(loaded!.players.map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('saves and reloads full matches including reports', () => {
    const league = createLeague('L3')
    const p1 = addPlayer(league.id, 'A')
    const p2 = addPlayer(league.id, 'B')
    insertMatches(league.id, [{ id: 'm1', round: 1, playerAId: p1.id, playerBId: p2.id }])
    upsertReport('m1', {
      reporterId: p1.id,
      result: 'A_WIN',
      touchdownsA: 2,
      touchdownsB: 1,
      casualtiesA: 3,
      casualtiesB: 0,
    })
    _resetDb()
    const reloaded = getLeague(league.id)!
    expect(reloaded!.matches).toHaveLength(1)
    expect(reloaded!.matches[0].round).toBe(1)
    expect(reloaded!.matches[0].reported).toMatchObject({ result: 'A_WIN', touchdownsA: 2 })
  })

  it('returns undefined for unknown league', () => {
    expect(getLeague('nope')).toBeUndefined()
  })

  it('getPlayers lists league players only', () => {
    const l1 = createLeague('one')
    const l2 = createLeague('two')
    addPlayer(l1.id, 'A')
    addPlayer(l2.id, 'B')
    expect(getPlayers(l1.id).map((p) => p.name)).toEqual(['A'])
  })

  it('renames a player row', () => {
    const l = createLeague('L')
    const p = addPlayer(l.id, 'Old')
    expect(renamePlayer(l.id, p.id, 'New')).toEqual({ id: p.id, name: 'New' })
    expect(getPlayers(l.id)[0].name).toBe('New')
  })

  it('renamePlayer returns undefined for wrong league/player', () => {
    const l = createLeague('L')
    const other = createLeague('other')
    const p = addPlayer(other.id, 'X')
    expect(renamePlayer(l.id, p.id, 'Y')).toBeUndefined()
  })

  it('updates match date and upserts (overwrites) report; clears date on null', () => {
    const l = createLeague('L')
    const a = addPlayer(l.id, 'A')
    const b = addPlayer(l.id, 'B')
    insertMatches(l.id, [{ id: 'm1', round: 1, playerAId: a.id, playerBId: b.id }])
    updateMatchDate('m1', '2026-08-01')
    expect(getLeague(l.id)!.matches[0].date).toBe('2026-08-01')
    upsertReport('m1', { reporterId: a.id, result: 'A_WIN', touchdownsA: 2, touchdownsB: 1, casualtiesA: 3, casualtiesB: 0 })
    upsertReport('m1', { reporterId: b.id, result: 'DRAW', touchdownsA: 1, touchdownsB: 1, casualtiesA: 0, casualtiesB: 0 })
    const m = getLeague(l.id)!.matches[0]
    expect(m.reported).toMatchObject({ result: 'DRAW', reporterId: b.id })
    // date survives report overwrite
    expect(m.date).toBe('2026-08-01')
    updateMatchDate('m1', null)
    expect(getLeague(l.id)!.matches[0].date).toBeUndefined()
  })

  it('findMatch locates a match with its league', () => {
    const l = createLeague('L')
    const a = addPlayer(l.id, 'A')
    const b = addPlayer(l.id, 'B')
    insertMatches(l.id, [{ id: 'mx', round: 3, playerAId: a.id, playerBId: b.id, date: '2026-09-01' }])
    const found = findMatch('mx')!
    expect(found.leagueId).toBe(l.id)
    expect(found.match.round).toBe(3)
    expect(found.match.date).toBe('2026-09-01')
    expect(findMatch('nope')).toBeUndefined()
  })

  it('inserts many matches in one call', () => {
    const l = createLeague('L')
    const a = addPlayer(l.id, 'A')
    const b = addPlayer(l.id, 'B')
    insertMatches(l.id, [
      { id: 'x1', round: 1, playerAId: a.id, playerBId: b.id },
      { id: 'x2', round: 1, playerAId: b.id, playerBId: a.id },
    ])
    expect(getLeague(l.id)!.matches).toHaveLength(2)
    // no-op when empty
    insertMatches(l.id, [])
  })

  it('migrates a legacy json-blob database on open', () => {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const path = process.env.BLOODTRACK_DB!
    // simulate a DB created by the pre-refactor code
    const legacy = new DatabaseSync(path)
    legacy.exec('CREATE TABLE leagues (id TEXT PRIMARY KEY, json TEXT NOT NULL)')
    const blob = JSON.stringify({
      id: 'lg1',
      name: 'Legacy League',
      players: [{ id: 'p1', name: 'Alice' }],
      matches: [
        {
          id: 'm1',
          round: 2,
          playerAId: 'p1',
          playerBId: 'ghost',
          date: '2026-08-01',
          reported: {
            reporterId: 'p1',
            result: 'A_WIN',
            touchdownsA: 3,
            touchdownsB: 1,
            casualtiesA: 0,
            casualtiesB: 2,
          },
        },
      ],
    })
    legacy.prepare('INSERT INTO leagues (id, json) VALUES (?, ?)').run('lg1', blob)
    legacy.close()

    _resetDb() // force fresh open through the migration path
    const l = getLeague('lg1')!
    expect(l.name).toBe('Legacy League')
    expect(l.players).toEqual([{ id: 'p1', name: 'Alice' }])
    expect(l.matches).toHaveLength(1)
    expect(l.matches[0]).toMatchObject({ id: 'm1', round: 2, date: '2026-08-01' })
    expect(l.matches[0].reported).toMatchObject({ result: 'A_WIN', touchdownsA: 3 })
    // writes work post-migration
    addPlayer('lg1', 'Bob')
    expect(getPlayers('lg1').map((p) => p.name)).toEqual(['Alice', 'Bob'])
    // legacy table is gone
    _resetDb()
    const d = new DatabaseSync(path)
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables).not.toContain('leagues_json_legacy')
    d.close()
  })
})
