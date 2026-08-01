import { describe, expect, it } from 'vitest'
import {
  backupNameFor,
  generateListName,
  isBackupName,
  isReadableListName,
  isValidListName,
  parseBackupName,
} from '#shared/listName'

describe('isValidListName', () => {
  it('accepts the shapes we generate', () => {
    expect(isValidListName('amber-mango-prz')).toBe(true)
    expect(isValidListName('a')).toBe(true)
    expect(isValidListName('list123')).toBe(true)
  })

  it('rejects anything that could escape the data directory', () => {
    for (const name of ['../etc/passwd', 'a/b', 'a\\b', '..', '.', 'a..b/c']) {
      expect(isValidListName(name), name).toBe(false)
    }
  })

  it('rejects leading punctuation, spaces and case', () => {
    for (const name of ['-leading', '.hidden', 'has space', 'UPPER', 'trailing.json']) {
      expect(isValidListName(name), name).toBe(false)
    }
  })

  it('rejects non-strings and over-long names', () => {
    expect(isValidListName(undefined)).toBe(false)
    expect(isValidListName(null)).toBe(false)
    expect(isValidListName(42)).toBe(false)
    expect(isValidListName('')).toBe(false)
    expect(isValidListName('a'.repeat(64))).toBe(true)
    expect(isValidListName('a'.repeat(65))).toBe(false)
  })

  it('does not treat a backup as a plain list', () => {
    expect(isValidListName('groceries.backup-2026-07-30')).toBe(false)
  })
})

describe('backup names', () => {
  it('builds a name from the local date', () => {
    expect(backupNameFor('groceries', new Date(2026, 6, 30, 23, 59))).toBe('groceries.backup-2026-07-30')
  })

  it('zero-pads months and days', () => {
    expect(backupNameFor('x', new Date(2026, 0, 5))).toBe('x.backup-2026-01-05')
  })

  it('round-trips through parseBackupName', () => {
    const name = backupNameFor('amber-mango-prz', new Date(2026, 6, 30))
    expect(parseBackupName(name)).toEqual({ source: 'amber-mango-prz', date: '2026-07-30' })
  })

  it('recognises only well-formed backups', () => {
    expect(isBackupName('groceries.backup-2026-07-30')).toBe(true)
    for (const name of [
      'groceries.backup-not-a-date',
      'groceries.backup-2026-7-30',
      'groceries.backup-',
      'groceries.backup',
      '.backup-2026-07-30',
      '../x.backup-2026-07-30',
      'a.backup-2026-07-30.backup-2026-07-31',
    ]) {
      expect(isBackupName(name), name).toBe(false)
    }
  })

  it('returns null when parsing a plain list name', () => {
    expect(parseBackupName('groceries')).toBeNull()
  })
})

describe('isReadableListName', () => {
  it('covers live lists and their backups, and nothing else', () => {
    expect(isReadableListName('groceries')).toBe(true)
    expect(isReadableListName('groceries.backup-2026-07-30')).toBe(true)
    expect(isReadableListName('../etc/passwd')).toBe(false)
    expect(isReadableListName('../etc/passwd.backup-2026-07-30')).toBe(false)
  })
})

describe('generateListName', () => {
  it('always produces a name the router and store will accept', () => {
    for (let i = 0; i < 200; i++) {
      const name = generateListName()
      expect(isValidListName(name), name).toBe(true)
    }
  })

  it('is varied enough not to collide constantly', () => {
    const names = new Set(Array.from({ length: 200 }, generateListName))
    expect(names.size).toBeGreaterThan(150)
  })
})
