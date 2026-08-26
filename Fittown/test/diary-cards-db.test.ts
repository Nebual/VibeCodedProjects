import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The database side of the Diary-cards preference: the `diary_cards_hidden`
 * column exists (fresh and migrated databases alike) and round-trips a JSON
 * array of hidden ids through user_goals.
 */

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-diary-cards-test-'))
  dbPath = join(dir, 'test.db')
  process.env.FITTOWN_DB_PATH = dbPath
})

afterEach(() => {
  delete process.env.FITTOWN_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  const { useDb } = await import('../server/utils/db')
  return useDb()
}

function seedUser(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES (1, 'cook@test', 'Cook')").run()
}

describe('diary_cards_hidden column', () => {
  it('exists on a fresh database and defaults to null', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare('INSERT INTO user_goals (user_id) VALUES (1)').run()
    const row = db.prepare('SELECT diary_cards_hidden FROM user_goals WHERE user_id = 1').get() as {
      diary_cards_hidden: string | null
    }
    expect(row.diary_cards_hidden).toBeNull()
  })

  it('round-trips a hidden list and clears on null', async () => {
    const db = await boot()
    seedUser(db)
    db.prepare('INSERT INTO user_goals (user_id) VALUES (1)').run()
    db.prepare('UPDATE user_goals SET diary_cards_hidden = ? WHERE user_id = 1')
      .run(JSON.stringify(['water', 'fitness']))
    let row = db.prepare('SELECT diary_cards_hidden FROM user_goals WHERE user_id = 1').get() as {
      diary_cards_hidden: string | null
    }
    expect(JSON.parse(row.diary_cards_hidden!)).toEqual(['water', 'fitness'])

    db.prepare('UPDATE user_goals SET diary_cards_hidden = NULL WHERE user_id = 1').run()
    row = db.prepare('SELECT diary_cards_hidden FROM user_goals WHERE user_id = 1').get() as {
      diary_cards_hidden: string | null
    }
    expect(row.diary_cards_hidden).toBeNull()
  })
})
