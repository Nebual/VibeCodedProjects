import { describe, expect, it } from 'vitest'
import { computeStandings, pairRound } from '../shared/scoring'
import type { League, Match } from '../shared/types'

function makeLeague(): League {
  const players = [
    { id: 'p1', name: 'Alice' },
    { id: 'p2', name: 'Bob' },
    { id: 'p3', name: 'Carol' },
    { id: 'p4', name: 'Dave' },
  ]
  const matches: Match[] = [
    {
      id: 'm1',
      round: 1,
      playerAId: 'p1',
      playerBId: 'p2',
      reported: {
        reporterId: 'p1',
        result: 'A_WIN',
        touchdownsA: 2,
        touchdownsB: 1,
        casualtiesA: 3,
        casualtiesB: 0,
      },
    },
    {
      id: 'm2',
      round: 1,
      playerAId: 'p3',
      playerBId: 'p4',
      reported: {
        reporterId: 'p3',
        result: 'DRAW',
        touchdownsA: 1,
        touchdownsB: 1,
        casualtiesA: 0,
        casualtiesB: 0,
      },
    },
  ]
  return { id: 'l1', name: 'Test League', players, matches }
}

describe('computeStandings', () => {
  it('awards 3 for win, 1 each for draw, 0 for loss', () => {
    const s = computeStandings(makeLeague())
    const alice = s.find((x) => x.playerId === 'p1')!
    const bob = s.find((x) => x.playerId === 'p2')!
    const carol = s.find((x) => x.playerId === 'p3')!
    expect(alice.points).toBe(3)
    expect(bob.points).toBe(0)
    expect(carol.points).toBe(1)
  })

  it('sums touchdowns and casualties inflicted', () => {
    const s = computeStandings(makeLeague())
    const alice = s.find((x) => x.playerId === 'p1')!
    expect(alice.touchdowns).toBe(2)
    expect(alice.casualties).toBe(3)
  })

  it('sorts by points desc, then TDs, then casualties', () => {
    const league = makeLeague()
    // Bob and Carol both have 3 pts scenario:
    // give Bob a win with more TDs than Alice? Simpler: craft explicit tie.
    league.matches.push({
      id: 'm3',
      round: 2,
      playerAId: 'p2',
      playerBId: 'p3',
      reported: {
        reporterId: 'p2',
        result: 'A_WIN',
        touchdownsA: 2,
        touchdownsB: 2,
        casualtiesA: 1,
        casualtiesB: 0,
      },
    })
    const s = computeStandings(league)
    // p2 (Bob): L + W = 3 pts. p1 Alice: 3. p3 Carol: D + L = 1.
    expect(s.map((x) => x.playerId)).toEqual(['p2', 'p1', 'p3', 'p4'])
  })

  it('breaks a pure point tie on touchdowns then casualties', () => {
    const league = makeLeague()
    // Make Alice and Bob tied on points (both 3): change m1 to draw handled below.
    league.matches[0].reported = {
      reporterId: 'p1',
      result: 'DRAW',
      touchdownsA: 1,
      touchdownsB: 1,
      casualtiesA: 2,
      casualtiesB: 5,
    }
    // Both now 1 pt from m1; give both another identical-points win via m3/m4
    league.matches.push(
      {
        id: 'm3',
        round: 2,
        playerAId: 'p1',
        playerBId: 'p3',
        reported: {
          reporterId: 'p1',
          result: 'A_WIN',
          touchdownsA: 2,
          touchdownsB: 0,
          casualtiesA: 1,
          casualtiesB: 0,
        },
      },
      {
        id: 'm4',
        round: 2,
        playerAId: 'p2',
        playerBId: 'p4',
        reported: {
          reporterId: 'p2',
          result: 'A_WIN',
          touchdownsA: 3,
          touchdownsB: 0,
          casualtiesA: 0,
          casualtiesB: 0,
        },
      },
    )
    // Alice: 4 pts, 3 TD, 3 CAS. Bob: 4 pts, 4 TD, 5 CAS -> Bob first on TDs.
    const s = computeStandings(league)
    expect(s[0].playerId).toBe('p2')
    expect(s[1].playerId).toBe('p1')
  })
})

describe('pairRound', () => {
  it('pairs sequentially: 1v2, 3v4, 5v6, 7v8', () => {
    const players = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      id: `p${n}`,
      name: `P${n}`,
    }))
    const pairs = pairRound(players)
    expect(pairs).toHaveLength(4)
    expect(pairs[0]).toEqual({ a: players[0], b: players[1] })
    expect(pairs[3]).toEqual({ a: players[6], b: players[7] })
  })

  it('gives the last unpaired player a bye on odd counts', () => {
    const players = [1, 2, 3].map((n) => ({ id: `p${n}`, name: `P${n}` }))
    const pairs = pairRound(players)
    expect(pairs).toEqual([{ a: players[0], b: players[1], bye: players[2] }])
  })
})
