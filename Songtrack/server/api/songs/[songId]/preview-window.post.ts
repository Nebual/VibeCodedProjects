import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../../database/client'
import { takes } from '../../../database/schema'
import { resolveSegmentPosition } from '#shared/utils/timeline'
import type { AfftdnFilter, EditFilter, EditList } from '#shared/types'
import type { ResolvedSegment } from '#shared/utils/timeline'

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const songId = getRouterParam(event, 'songId')!
  getOwnedSong(actor.user.id, songId)

  const body = await readBody<{
    segments: ResolvedSegment[]
    center: number
    padding?: number
    filters?: EditFilter[]
    gain?: EditList['gain']
    audition?: boolean
    clickAtCenter?: boolean
  }>(event)
  if (!body?.segments?.length) {
    throw createError({ statusCode: 400, statusMessage: 'No segments to preview' })
  }

  const songTakes = db.select().from(takes).where(eq(takes.songId, songId)).all()
  const validIds = new Set(songTakes.map(t => t.id))
  if (body.segments.some(s => !validIds.has(s.source))) {
    throw createError({ statusCode: 400, statusMessage: 'Segment references an unknown take' })
  }

  const centerResolved = resolveSegmentPosition(body.segments, body.center)
  if (!centerResolved) {
    throw createError({ statusCode: 400, statusMessage: 'Preview center is outside the segments' })
  }
  const centerTake = songTakes.find(t => t.id === centerResolved.source)!

  const padding = body.padding ?? 3
  const start = Math.max(0, centerResolved.localTime - padding)
  const duration = padding * 2

  const outPath = join(rendersDir(), `previewwin-${songId}-${nanoid()}.ogg`)
  const codecArgs = ['-c:a', 'libopus', '-b:a', '192k']
  const inputArgs = ['-ss', String(start), '-t', String(duration), '-i', centerTake.sourcePath]

  const filterParts: string[] = []
  let outputLabel = '0:a'

  if (body.filters?.length) {
    if (body.audition && !body.filters.some(f => f.type === 'afftdn')) {
      throw createError({ statusCode: 400, statusMessage: 'No noise-reduction filter to audition' })
    }
    // afftdn's learned-profile training can only ever apply to audio that comes *after* it in the
    // processed stream — never to what already played before. The ambience region can fall
    // anywhere relative to this short window (typically nowhere near it, since it's captured at
    // the tail of a recording), so its training clip is read from the take a second time here
    // and handed to the filter graph separately, rather than assumed to already be present in the
    // windowed input.
    const afftdnWithRegion = body.filters.find((f): f is AfftdnFilter =>
      f.type === 'afftdn' && !!f.noiseRegion && f.noiseRegion.end > f.noiseRegion.start)
    let noiseTrainingLabel: string | undefined
    if (afftdnWithRegion?.noiseRegion) {
      const { start: regionStart, end: regionEnd } = afftdnWithRegion.noiseRegion
      const trainResolved = resolveSegmentPosition(body.segments, regionStart)
      if (trainResolved) {
        const trainTake = songTakes.find(t => t.id === trainResolved.source)!
        inputArgs.push('-ss', String(trainResolved.localTime), '-t', String(regionEnd - regionStart), '-i', trainTake.sourcePath)
        noiseTrainingLabel = '1:a'
      }
    }
    const graph = buildFiltersOnlyGraph('0:a', body.filters, body.gain, { audition: body.audition, noiseTrainingLabel })
    filterParts.push(graph.filterComplex)
    outputLabel = graph.outputLabel
  }

  // An audible tick dropped exactly at the trim point, so you can *hear* where a cut lands
  // instead of only seeing a seek-bar marker — matters because the window is padded
  // asymmetrically whenever there isn't enough audio on one side (e.g. trimming 1s off the
  // very start of a take), so the cut is not always at the midpoint of what plays.
  if (body.clickAtCenter) {
    const clickMs = Math.max(0, Math.round((centerResolved.localTime - start) * 1000))
    filterParts.push(`sine=frequency=1200:duration=0.025:sample_rate=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.35,adelay=${clickMs}|${clickMs}[click]`)
    filterParts.push(`[${outputLabel}]aformat=sample_rates=48000:channel_layouts=stereo[mainfmt]`)
    filterParts.push('[mainfmt][click]amix=inputs=2:duration=first:normalize=0[mixed]')
    outputLabel = 'mixed'
  }

  if (filterParts.length > 0) {
    await runFfmpeg([
      ...inputArgs,
      '-filter_complex', filterParts.join(';'),
      '-map', `[${outputLabel}]`,
      ...codecArgs,
      outPath,
    ])
  } else {
    await runFfmpeg([...inputArgs, ...codecArgs, outPath])
  }

  const buf = await readFile(outPath)
  await rm(outPath, { force: true })

  setHeader(event, 'Content-Type', 'audio/ogg')
  return buf
})
