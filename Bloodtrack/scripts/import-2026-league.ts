#!/usr/bin/env -S node --experimental-strip-types
/**
 * Import the 2026 Bloodtrack league schedule.
 *
 * Creates "2026 League" with 8 teams, then generates the full round-robin
 * schedule (7 rounds, each matchup exactly once) with round dates matching
 * the published calendar (each round = 14 days starting Aug 1).
 *
 * Usage:
 *   BLOODTRACK_DB=data/bloodtrack.db node --experimental-strip-types scripts/import-2026-league.ts [baseUrl]
 * (baseUrl only needed if importing against a running server; default writes directly to SQLite)
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TEAMS = [
  'Hornets',
  'Undercity Skewers',
  'Gobstompers',
  'Boneheads',
  'Norse',
  'Khorne Dogs',
  'Lizards',
  'Torqued Up Blorcs',
]

// Published schedule (team names), used verbatim so rounds/dates match.
const SCHEDULE: { label: string; start: string; fixtures: [string, string][] }[] = [
  {
    label: 'Round 1',
    start: '2026-08-01',
    fixtures: [
      ['Hornets', 'Undercity Skewers'],
      ['Gobstompers', 'Boneheads'],
      ['Norse', 'Khorne Dogs'],
      ['Lizards', 'Torqued Up Blorcs'],
    ],
  },
  {
    label: 'Round 2',
    start: '2026-08-15',
    fixtures: [
      ['Khorne Dogs', 'Gobstompers'],
      ['Hornets', 'Lizards'],
      ['Torqued Up Blorcs', 'Norse'],
      ['Undercity Skewers', 'Boneheads'],
    ],
  },
  {
    label: 'Round 3',
    start: '2026-08-29',
    fixtures: [
      ['Norse', 'Hornets'],
      ['Gobstompers', 'Undercity Skewers'],
      ['Lizards', 'Boneheads'],
      ['Khorne Dogs', 'Torqued Up Blorcs'],
    ],
  },
  {
    label: 'Round 4',
    start: '2026-09-12',
    fixtures: [
      ['Undercity Skewers', 'Lizards'],
      ['Torqued Up Blorcs', 'Gobstompers'],
      ['Hornets', 'Khorne Dogs'],
      ['Boneheads', 'Norse'],
    ],
  },
  {
    label: 'Round 5',
    start: '2026-09-26',
    fixtures: [
      ['Norse', 'Undercity Skewers'],
      ['Khorne Dogs', 'Boneheads'],
      ['Lizards', 'Gobstompers'],
      ['Torqued Up Blorcs', 'Hornets'],
    ],
  },
  {
    label: 'Round 6',
    start: '2026-10-10',
    fixtures: [
      ['Lizards', 'Norse'],
      ['Boneheads', 'Torqued Up Blorcs'],
      ['Undercity Skewers', 'Khorne Dogs'],
      ['Gobstompers', 'Hornets'],
    ],
  },
  {
    label: 'Round 7',
    start: '2026-10-24',
    fixtures: [
      ['Khorne Dogs', 'Lizards'],
      ['Hornets', 'Boneheads'],
      ['Torqued Up Blorcs', 'Undercity Skewers'],
      ['Norse', 'Gobstompers'],
    ],
  },
]

const dbPath = process.env.BLOODTRACK_DB ?? join(process.cwd(), 'data', 'bloodtrack.db')
mkdirSync(dirname(dbPath), { recursive: true })
const db = new DatabaseSync(dbPath)
db.exec('CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, json TEXT NOT NULL)')

const existingRow = db.prepare('SELECT json FROM leagues WHERE json LIKE ?').get('%"name":"2026 League"%') as
  | { json: string }
  | undefined

const id = () => randomUUID()

let league: any
if (existingRow) {
  league = JSON.parse(existingRow.json)
  console.log(`Found existing "2026 League" (${league.id}); adding missing matches only.`)
} else {
  league = { id: id(), name: '2026 League', players: [], matches: [] }
}

const byName = new Map(league.players.map((p: any) => [p.name, p]))
for (const name of TEAMS) {
  if (!byName.has(name)) {
    const p = { id: id(), name }
    league.players.push(p)
    byName.set(name, p)
  }
}

const scheduled = new Set(
  league.matches.flatMap((m: any) => [`${m.playerAId}|${m.playerBId}`, `${m.playerBId}|${m.playerAId}`]),
)

// sanity: the published schedule must have no repeated matchups
const seen = new Set<string>()
for (const round of SCHEDULE) {
  for (const [a, b] of round.fixtures) {
    const key = [a, b].sort().join('|')
    if (seen.has(key)) throw new Error(`Duplicate matchup in schedule: ${key}`)
    seen.add(key)
  }
}
console.log(`Schedule check OK: ${seen.size} unique matchups across ${SCHEDULE.length} rounds.`)

let createdCount = 0
for (const round of SCHEDULE) {
  const roundNo = Number(round.label.split(' ')[1])
  let maxRound = league.matches.reduce((m: number, x: any) => Math.max(m, x.round), 0)
  for (const [aName, bName] of round.fixtures) {
    const a = byName.get(aName)!
    const b = byName.get(bName)!
    if (scheduled.has(`${a.id}|${b.id}`)) continue
    league.matches.push({
      id: id(),
      round: roundNo,
      playerAId: a.id,
      playerBId: b.id,
      date: round.start,
    })
    scheduled.add(`${a.id}|${b.id}`)
    createdCount++
    void maxRound
    maxRound = Math.max(maxRound, roundNo)
  }
}

db.prepare(
  'INSERT INTO leagues (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
).run(league.id, JSON.stringify(league))

console.log(
  `Imported ${createdCount} matches (${league.matches.length} total) into "${league.name}" — league id: ${league.id}`,
)
console.log(`DB: ${dbPath}`)
