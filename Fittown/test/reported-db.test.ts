import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { reportedFilter } from '../server/utils/foods'

/**
 * The report/undo SQL predicate that keeps flagged foods out of every browse
 * list, with the one owner exemption — the trickiest part of the "report as
 * inaccurate" feature, and the easiest to get wrong in a JOIN.
 */
let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fittown-report-'))
  dbPath = join(dir, 'test.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function open() {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE foods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_user_id INTEGER,
      reported_by INTEGER,
      kcal REAL
    );
  `)
  return db
}

/** `reported_by` a row shares the column got; returns ids that pass the filter. */
function visibleRows(db: DatabaseSync, viewerId: number): number[] {
  const rows = db
    .prepare(`SELECT id FROM foods WHERE (${reportedFilter('foods', String(viewerId))})`)
    .all() as { id: number }[]
  return rows.map((r) => r.id)
}

describe('reportedFilter', () => {
  it('hides a reported food from everyone except a custom food’s owner', () => {
    const db = open()
    db.prepare(
      "INSERT INTO foods (id, source, name, owner_user_id, reported_by) VALUES (1,'custom','X',2,3)",
    ).run()
    db.prepare("INSERT INTO foods (id, source, name) VALUES (2,'off','Y')").run()

    // Viewer 3 reported it — even the reporter can't see it.
    expect(visibleRows(db, 3)).toEqual([2])
    // A bystander can't either.
    expect(visibleRows(db, 1)).toEqual([2])
    // The owner (2) can.
    expect(visibleRows(db, 2).sort()).toEqual([1, 2])
  })

  it('hides a reported OFF product from everyone', () => {
    const db = open()
    db.prepare("INSERT INTO foods (id, source, name, reported_by) VALUES (1,'off','X',5)").run()
    expect(visibleRows(db, 5)).toEqual([])
    expect(visibleRows(db, 1)).toEqual([])
  })

  it('shows everything when nothing is reported', () => {
    const db = open()
    db.prepare("INSERT INTO foods (id, source, name) VALUES (1,'off','A')").run()
    db.prepare("INSERT INTO foods (id, source, name, owner_user_id) VALUES (2,'custom','B',7)").run()
    expect(visibleRows(db, 1).sort()).toEqual([1, 2])
  })
})