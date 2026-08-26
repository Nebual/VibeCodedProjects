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

  it('generates round 1 with 4 sequential pairings', async () => {
    const res = await (
      await fetch(`${base}/api/leagues/${leagueId}/rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()
    expect(res.round).toBe(1)
    expect(res.matches).toHaveLength(4)
    // set dates so the external endpoint can find "today's" match
    const m1 = res.matches[0]
    await (
      await fetch(`${base}/api/matches/${m1.id}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reporterId: m1.playerAId,
          result: 'A_WIN',
          touchdownsA: 1,
          touchdownsB: 0,
          casualtiesA: 0,
          casualtiesB: 0,
          date: today,
        }),
      })
    ).json()
  })

  it('lists matches ordered by date', async () => {
    const res = await (await fetch(`${base}/api/leagues/${leagueId}/matches`)).json()
    expect(res.matches).toHaveLength(4)
    const dated = res.matches.filter((m: any) => m.date)
    expect(dated).toHaveLength(1)
    expect(dated[0].date).toBe(today)
  })

  it('external endpoint increments touchdowns on the current match', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/external/leagues/${leagueId}/touchdowns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

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
    const alice = standings.find((s: any) => s.name === 'Alice')
    expect(alice.points).toBe(3)
    expect(alice.touchdowns).toBe(5)
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
})
