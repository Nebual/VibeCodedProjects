import { describe, expect, it } from 'vitest'
import {
  comparableTime,
  friendDisplayName,
  friendInitial,
  inviteProblem,
  inviteUrl,
  isInviteUsable,
  isShareToken,
  sharedRecipeUrl,
  uniqueCopyName,
} from '#shared/friends'
import {
  SHARE_KEYS,
  SHARE_TOGGLES,
  sharePermissions,
  sharedCount,
  sharesNothing,
} from '#shared/sharing'

describe('naming people', () => {
  it('prefers the name Google gave us', () => {
    expect(friendDisplayName({ name: 'Ada Lovelace', email: 'ada@x.test' })).toBe('Ada Lovelace')
  })

  it('falls back to the email local part rather than showing a blank row', () => {
    expect(friendDisplayName({ name: '', email: 'ada@x.test' })).toBe('ada')
    expect(friendDisplayName({ name: '   ', email: 'ada@x.test' })).toBe('ada')
    expect(friendDisplayName({})).toBe('Someone')
  })

  it('gives the avatar circle a letter in every case', () => {
    expect(friendInitial({ name: 'ada' })).toBe('A')
    expect(friendInitial({ email: 'zoe@x.test' })).toBe('Z')
    expect(friendInitial({})).toBe('S')
  })
})

describe('invite lifetime', () => {
  /**
   * The formats are the point of this one. SQLite writes
   * `2026-08-16 12:00:00`; JavaScript hands out `2026-08-16T12:00:00.000Z`.
   * Compared as raw strings, 'T' (0x54) sorts after ' ' (0x20), so an invite
   * would read as expired for the rest of the day it was made.
   */
  it('compares a SQLite timestamp against a JavaScript one', () => {
    const invite = { expires_at: '2026-09-15 12:00:00' }
    expect(isInviteUsable(invite, '2026-08-16T12:00:00.000Z')).toBe(true)
    expect(isInviteUsable(invite, '2026-09-16T12:00:00.000Z')).toBe(false)
  })

  it('is still valid later on the day it expires', () => {
    // The case the normalisation exists for: compared raw, ' ' sorts before
    // 'T', so a link with hours left to run reads as already dead.
    expect(
      isInviteUsable({ expires_at: '2026-08-16 23:00:00' }, '2026-08-16T12:00:00.000Z'),
    ).toBe(true)
  })

  it('normalises both forms to the same shape', () => {
    expect(comparableTime('2026-08-16T12:00:00.000Z')).toBe('2026-08-16 12:00:00')
    expect(comparableTime('2026-08-16 12:00:00')).toBe('2026-08-16 12:00:00')
  })

  it('is unusable once revoked, whatever the expiry says', () => {
    const now = '2026-08-16 12:00:00'
    const live = { expires_at: '2026-09-15 12:00:00' }
    expect(isInviteUsable({ ...live, revoked_at: '2026-08-16 11:00:00' }, now)).toBe(false)
  })

  it('ignores accepted_at — the link is multi-use, not spent by one visit', () => {
    const now = '2026-08-16 12:00:00'
    const live = { expires_at: '2026-09-15 12:00:00' }
    // A legacy row may still carry an old accepted_at; it must not block reuse.
    expect(isInviteUsable({ ...live, accepted_at: '2026-08-16 11:00:00' }, now)).toBe(true)
  })

  it('says which of the two it is, so the page can explain itself', () => {
    const now = '2026-08-16 12:00:00'
    expect(inviteProblem({ expires_at: '2026-09-15 12:00:00' }, now)).toBeNull()
    expect(inviteProblem({ expires_at: '2026-01-01 12:00:00' }, now)).toMatch(/expired/i)
    expect(
      inviteProblem({ expires_at: '2026-09-15 12:00:00', revoked_at: 'x' }, now),
    ).toMatch(/cancelled/i)
  })

  it('reports revocation ahead of expiry — the owner meant it', () => {
    const dead = { expires_at: '2026-01-01 12:00:00', revoked_at: 'x' }
    expect(inviteProblem(dead, '2026-08-16 12:00:00')).toMatch(/cancelled/i)
  })
})

describe('naming a copied recipe', () => {
  it('keeps the name when it is free', () => {
    expect(uniqueCopyName('Chili', ['Soup'])).toBe('Chili')
  })

  it('does not leave two identical rows in your list', () => {
    expect(uniqueCopyName('Chili', ['Chili'])).toBe('Chili (copy)')
    expect(uniqueCopyName('Chili', ['Chili', 'Chili (copy)'])).toBe('Chili (copy 2)')
  })

  it('matches case-insensitively, since the list sorts that way too', () => {
    expect(uniqueCopyName('Chili', ['CHILI'])).toBe('Chili (copy)')
  })

  it('never returns an empty name for the foods table', () => {
    expect(uniqueCopyName('   ', [])).toBe('Recipe')
  })

  it('leaves room for the suffix inside the column limit', () => {
    const long = 'x'.repeat(300)
    expect(uniqueCopyName(long, []).length).toBeLessThanOrEqual(180)
    expect(uniqueCopyName(long, [long.slice(0, 180)]).length).toBeLessThanOrEqual(200)
  })
})

describe('share tokens', () => {
  it('accepts what newToken() produces and rejects the rest', () => {
    expect(isShareToken('rIhSVzRHzTfoWRHRcOwbjw')).toBe(true)
    expect(isShareToken('short')).toBe(false)
    expect(isShareToken('has spaces in it here')).toBe(false)
    // A path traversal or a SQL fragment never reaches the database.
    expect(isShareToken('../../etc/passwd')).toBe(false)
    expect(isShareToken("' OR 1=1 --")).toBe(false)
    expect(isShareToken(undefined)).toBe(false)
  })
})

describe('link building', () => {
  it('does not double the slash when the origin has one', () => {
    expect(inviteUrl('https://fit.example/', 'abc')).toBe('https://fit.example/invite/abc')
    expect(sharedRecipeUrl('https://fit.example', 'abc')).toBe('https://fit.example/r/abc')
  })
})

describe('sharing switches', () => {
  it('treats an absent column as shared, matching the DB default', () => {
    // An older database that hasn't been through the migration must not read
    // as "everything is private" and silently blank a friend's page.
    const all = sharePermissions({})
    expect(SHARE_KEYS.every((key) => all[key])).toBe(true)
    expect(sharePermissions(null).share_recipes).toBe(true)
  })

  it('reads 0 and 1 the way SQLite stores them', () => {
    const some = sharePermissions({ share_recipes: 0, share_weight: 1 })
    expect(some.share_recipes).toBe(false)
    expect(some.share_weight).toBe(true)
  })

  it('counts what is on', () => {
    expect(sharedCount(sharePermissions({}))).toBe(6)
    expect(sharesNothing(sharePermissions({}))).toBe(false)

    const off = Object.fromEntries(SHARE_KEYS.map((key) => [key, 0]))
    expect(sharedCount(sharePermissions(off))).toBe(0)
    expect(sharesNothing(sharePermissions(off))).toBe(true)
  })

  it('has a Custom foods switch that defaults on', () => {
    expect(sharePermissions({}).share_custom_foods).toBe(true)
    expect(sharePermissions({ share_custom_foods: 0 }).share_custom_foods).toBe(false)
    // Listed *between* the food-ish switches so Settings reads naturally.
    const toggle = SHARE_TOGGLES.find((t) => t.key === 'share_custom_foods')
    expect(toggle?.label).toBe('Custom foods')
  })

  it('has a label and an explanation for every switch it stores', () => {
    expect(SHARE_TOGGLES).toHaveLength(SHARE_KEYS.length)
    for (const toggle of SHARE_TOGGLES) {
      expect(toggle.label.length).toBeGreaterThan(0)
      expect(toggle.description.length).toBeGreaterThan(0)
      expect(toggle.key.startsWith('share_')).toBe(true)
    }
  })
})
