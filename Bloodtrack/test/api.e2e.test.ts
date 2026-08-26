import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PORT = 3201
let base: string
let child: ReturnType<typeof spawn> | undefined

async function waitForServer(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('dev server did not start')
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bloodtrack-e2e-'))
  child = spawn(
    process.execPath,
    [join(import.meta.dirname, '../node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', String(PORT)],
    {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, BLOODTRACK_DB: join(dir, 'e2e.db'), NODE_ENV: 'development' },
      stdio: 'pipe',
    },
  )
  let output = ''
  child.stdout?.on('data', (d) => (output += d))
  child.stderr?.on('data', (d) => (output += d))
  child.on('exit', () => {})
  base = `http://localhost:${PORT}`
  await waitForServer(`${base}/api/leagues`)
}, 120_000)

afterAll(() => {
  child?.kill('SIGTERM')
})

let leagueId = ''
const today = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

describe('Bloodtrack API e2e', () => {
  it('creates a league and adds players', async () => {
    const league = await (
      await fetch(`${base}/api/leagues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'E2E Cup' }),
      })
    ).json()
    leagueId = league.id
    expect(league.name).toBe('E2E Cup')

    for (const name of ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi']) {
      const p = await (
        await fetch(`${base}/api/leagues/${leagueId}/players`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).json()
      expect(p.id).toBeTruthy()
    }
  })

  it('generates the full round-robin (7 rounds, 28 matches for 8 players)', async () => {
    const res = await (
      await fetch(`${base}/api/leagues/${leagueId}/rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()
    expect(res.createdRounds).toBe(7)
    expect(res.createdMatches).toBe(28)

    // every matchup exactly once
    const pairs = new Set<string>()
    for (const m of res.matches) {
      const key = [m.playerAId, m.playerBId].sort().join('|')
      expect(pairs.has(key)).toBe(false)
      pairs.add(key)
    }
    expect(pairs.size).toBe(28)

    // idempotent: re-running adds nothing
    const again = await (
      await fetch(`${base}/api/leagues/${leagueId}/rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()
    expect(again.createdMatches).toBe(0)
  })

  it('reports a match with today\'s date', async () => {
    const matches = await (await fetch(`${base}/api/leagues/${leagueId}/matches`)).json()
    const m1 = matches.matches[0]
    await fetch(`${base}/api/matches/${m1.id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reporterId: '__admin__',
        result: 'A_WIN',
        touchdownsA: 1,
        touchdownsB: 0,
        casualtiesA: 0,
        casualtiesB: 0,
        date: today,
      }),
    })
  })

  it('lists matches ordered by date', async () => {
    const res = await (await fetch(`${base}/api/leagues/${leagueId}/matches`)).json()
    expect(res.matches).toHaveLength(28)
    const dated = res.matches.filter((m: any) => m.date)
    expect(dated).toHaveLength(1)
    expect(dated[0].date).toBe(today)
    // dated match sorts first
    expect(res.matches[0].id).toBe(dated[0].id)
  })

  it('external endpoint increments touchdowns on the current match', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/external/leagues/${leagueId}/touchdowns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    const matches = await (await fetch(`${base}/api/leagues/${leagueId}/matches`)).json()
    const dated = matches.matches.find((m: any) => m.date)
    const inc = await (await post({ player: 'B', op: 'inc' })).json()
    expect(inc.touchdownsB).toBe(1)

    await post({ player: 'B', op: 'inc' })
    await post({ player: 'B', op: 'inc' })
    const dec = await (await post({ player: 'B', op: 'dec' })).json()
    expect(dec.touchdownsB).toBe(2)

    const set = await (await post({ player: 'A', op: 'set', amount: 5 })).json()
    expect(set.touchdownsA).toBe(5)

    // standings reflect external TD updates (match was A win; set overwrote TDsA to 5)
    const standings = await (await fetch(`${base}/api/leagues/${leagueId}/standings`)).json()
    const playerAName = dated.playerA.name
    const pa = standings.find((s: any) => s.name === playerAName)
    expect(pa.points).toBe(3)
    expect(pa.touchdowns).toBe(5)
  })

  it('lets a player rename themselves but not others', async () => {
    const league = await (await fetch(`${base}/api/leagues/${leagueId}`)).json()
    const p0 = league.players[0]
    const p1 = league.players[1]

    // self-rename works
    const ok = await fetch(`${base}/api/leagues/${leagueId}/players/${p0.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: p0.id, name: 'Renamed One' }),
    })
    expect(ok.status).toBe(200)
    const after = await (await fetch(`${base}/api/leagues/${leagueId}`)).json()
    expect(after.players.find((p: any) => p.id === p0.id).name).toBe('Renamed One')

    // renaming someone else is forbidden
    const forbidden = await fetch(`${base}/api/leagues/${leagueId}/players/${p1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: p0.id, name: 'Hacked' }),
    })
    expect(forbidden.status).toBe(403)

    // admin can rename anyone
    const admin = await fetch(`${base}/api/leagues/${leagueId}/players/${p1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: '__admin__', name: 'Admin Renamed' }),
    })
    expect(admin.status).toBe(200)

    // empty name rejected
    const empty = await fetch(`${base}/api/leagues/${leagueId}/players/${p1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: '__admin__', name: '  ' }),
    })
    expect(empty.status).toBe(400)
  })

  it('rejects bad external payloads and non-participant reporters', async () => {
    const badOp = await fetch(`${base}/api/external/leagues/${leagueId}/touchdowns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: 'A', op: 'explode' }),
    })
    expect(badOp.status).toBe(400)

    const matches = await (await fetch(`${base}/api/leagues/${leagueId}/matches?round=1`)).json()
    const unreported = matches.matches.find((m: any) => !m.reported)
    const forbidden = await fetch(`${base}/api/matches/${unreported.id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reporterId: 'someone-else',
        result: 'DRAW',
        touchdownsA: 0,
        touchdownsB: 0,
        casualtiesA: 0,
        casualtiesB: 0,
      }),
    })
    expect([400, 403]).toContain(forbidden.status)
  })

  it('date endpoint: admin ok, outsider forbidden, bad date rejected', async () => {
    const matches = await (await fetch(`${base}/api/leagues/${leagueId}/matches`)).json()
    const m = matches.matches[0]

    const forbidden = await fetch(`${base}/api/matches/${m.id}/date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: 'random-bystander', date: '2026-09-01' }),
    })
    expect(forbidden.status).toBe(403)

    const badDate = await fetch(`${base}/api/matches/${m.id}/date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: '__admin__', date: 'not-a-date' }),
    })
    expect(badDate.status).toBe(400)

    const missing = await fetch(`${base}/api/matches/does-not-exist/date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: '__admin__', date: '2026-09-01' }),
    })
    expect(missing.status).toBe(404)

    const ok = await fetch(`${base}/api/matches/${m.id}/date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: '__admin__', date: '2026-09-01' }),
    })
    expect(ok.status).toBe(200)
    const after = await (await fetch(`${base}/api/matches/${m.id}/date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: '__admin__', date: null }),
    })).json()
    expect(after.date).toBeUndefined()
  })
})
