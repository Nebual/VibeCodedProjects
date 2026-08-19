import type { Dirent } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../database/client'

export function dirSizeBytes(dir: string): number {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size
  }
  return total
}

export function userAudioDir(userId: string): string {
  return join(dataDir, 'audio', userId)
}
