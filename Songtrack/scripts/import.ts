import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { nanoid } from 'nanoid'
import { db } from '../server/database/client'
import { songs, takes, users } from '../server/database/schema'
import { ffprobe, generatePeaks, renderEditList } from '../server/utils/ffmpeg'
import { songDir } from '../server/utils/paths'
import { resolveTimeline } from '../shared/utils/timeline'
import { slugify } from '../shared/utils/slug'
import type { EditList } from '../shared/types'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma', '.opus', '.webm'])

function parseArgs() {
  const args = process.argv.slice(2)
  const folder = args.find(a => !a.startsWith('--'))
  const userIdx = args.indexOf('--user')
  const userEmail = userIdx >= 0 ? args[userIdx + 1] : undefined
  if (!folder || !userEmail) {
    console.error('Usage: npm run import -- <folder> --user <email>')
    process.exit(1)
  }
  return { folder, userEmail }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(full))
    } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(full)
    }
  }
  return files
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

function titleFromFilename(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.[^.]+$/, '')
}

async function main() {
  const { folder, userEmail } = parseArgs()

  // Self-sufficient even if the server has never booted yet in this environment.
  migrate(db, { migrationsFolder: 'server/database/migrations' })

  const user = db.select().from(users).where(eq(users.email, userEmail)).get()
  if (!user) {
    console.error(`No user found with email ${userEmail}. Sign in once via Google first, then re-run.`)
    process.exit(1)
  }

  const files = await walk(folder)
  console.log(`Found ${files.length} audio file(s) under ${folder}`)

  let imported = 0
  let skipped = 0

  for (const filePath of files) {
    const hash = await hashFile(filePath)
    const existing = db.select().from(songs)
      .where(and(eq(songs.userId, user.id), eq(songs.importHash, hash)))
      .get()
    if (existing) {
      skipped++
      continue
    }

    const fileStat = await stat(filePath)
    const title = titleFromFilename(filePath)
    const songId = nanoid()
    const takeId = nanoid()

    const dir = songDir(user.id, songId)
    const takeDir = join(dir, 'takes')
    await mkdir(takeDir, { recursive: true })
    const takePath = join(takeDir, `${takeId}${extname(filePath).toLowerCase()}`)
    await copyFile(filePath, takePath)

    const takeProbe = await ffprobe(takePath)

    db.insert(songs).values({
      id: songId,
      userId: user.id,
      title,
      slug: slugify(title),
      editList: { segments: [], filters: [] },
      importHash: hash,
      createdAt: fileStat.mtime,
      updatedAt: fileStat.mtime,
    }).run()

    db.insert(takes).values({
      id: takeId,
      songId,
      sourcePath: takePath,
      timelineStart: 0,
      durationS: takeProbe.durationS,
      ordinal: 0,
      createdAt: fileStat.mtime,
    }).run()

    const editList: EditList = {
      segments: resolveTimeline([{ id: takeId, timelineStart: 0, duration: takeProbe.durationS }]),
      filters: [],
    }
    const masterPath = join(dir, 'master.ogg')
    const peaksPath = join(dir, 'peaks.json')

    await renderEditList([{ id: takeId, path: takePath }], editList, masterPath, 'ogg')
    const [masterProbe, peaks] = await Promise.all([ffprobe(masterPath), generatePeaks(masterPath)])
    await writeFile(peaksPath, JSON.stringify(peaks))

    db.update(songs).set({
      masterPath,
      peaksPath,
      editList,
      durationS: masterProbe.durationS,
      sampleRate: masterProbe.sampleRate,
      channels: masterProbe.channels,
    }).where(eq(songs.id, songId)).run()

    imported++
    console.log(`Imported: ${title}`)
  }

  console.log(`Done. Imported ${imported}, skipped ${skipped} already-imported file(s).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
