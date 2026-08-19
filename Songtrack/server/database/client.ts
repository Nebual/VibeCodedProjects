import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export const dataDir = process.env.DATA_DIR || '.data'
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(dataDir, 'audio'), { recursive: true })
mkdirSync(join(dataDir, 'renders'), { recursive: true })

const sqlite = new Database(join(dataDir, 'songtrack.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export { sqlite }
