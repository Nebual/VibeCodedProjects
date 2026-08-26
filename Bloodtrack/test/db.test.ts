import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addPlayer,
  createLeague,
  getLeague,
  listLeagues,
  saveLeague,
} from '../server/utils/db'
import type { League } from '../shared/types'

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
})

describe('db', () => {
  it('creates a league and lists it', () => {
    const league = createLeague('My League')
    expect(league.name).toBe('My League')
    expect(league.players).toEqual([])
    const listed = listLeagues()
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe('My League')
  })

  it('persists players across db re-open', () => {
    const league = createLeague('L2')
    addPlayer(league.id, 'Alice')
    addPlayer(league.id, 'Bob')
    // fresh open (new module-level cache is bypassed by re-calling; db file re-read)
    const loaded = getLeague(league.id)!
    expect(loaded!.players.map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('saves and reloads full league blobs including matches', () => {
    const league = createLeague('L3')
    const p1 = addPlayer(league.id, 'A')
    const p2 = addPlayer(league.id, 'B')
    const updated: League = getLeague(league.id)!
    updated.matches.push({
      id: 'm1',
      round: 1,
      playerAId: p1.id,
      playerBId: p2.id,
    })
    saveLeague(updated)
    const reloaded = getLeague(league.id)
    expect(reloaded!.matches).toHaveLength(1)
    expect(reloaded!.matches[0].round).toBe(1)
  })

  it('returns undefined for unknown league', () => {
    expect(getLeague('nope')).toBeUndefined()
  })
})
