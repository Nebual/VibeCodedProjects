import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { dataDir } from '../database/client'

export function songDir(userId: string, songId: string): string {
  const dir = join(dataDir, 'audio', userId, songId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function songTmpDir(userId: string, songId: string): string {
  const dir = join(songDir(userId, songId), 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function takeChunkDir(userId: string, songId: string, takeId: string): string {
  const dir = join(songTmpDir(userId, songId), takeId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function takeFinalPath(userId: string, songId: string, takeId: string, ext: string): string {
  const dir = join(songDir(userId, songId), 'takes')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${takeId}.${ext}`)
}

export function rendersDir(): string {
  const dir = join(dataDir, 'renders')
  mkdirSync(dir, { recursive: true })
  return dir
}
