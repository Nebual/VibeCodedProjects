import { describe, expect, it } from 'vitest'
import { buildFilterGraph, buildFiltersOnlyGraph, resolveNoiseTrainingSource } from '../../server/utils/ffmpeg'
import type { EditFilter, EditList } from '../../shared/types'

const SOURCES = [
  { id: 'take-1', path: '/data/take-1.ogg' },
  { id: 'take-2', path: '/data/take-2.ogg' },
]

function editList(overrides: Partial<EditList> = {}): EditList {
  return {
    segments: [{ source: 'take-1', start: 0, end: 10 }],
    filters: [],
    ...overrides,
  }
}

describe('buildFilterGraph', () => {
  it('rejects an edit list with no segments', () => {
    expect(() => buildFilterGraph(SOURCES, editList({ segments: [] }))).toThrow('no segments')
  })

  it('rejects a segment referencing a source not in the take list', () => {
    expect(() => buildFilterGraph(SOURCES, editList({ segments: [{ source: 'ghost', start: 0, end: 1 }] })))
      .toThrow('Missing source for take ghost')
  })

  it('trims and formats a single segment, one input per unique source', () => {
    const graph = buildFilterGraph(SOURCES, editList())
    expect(graph.inputArgs).toEqual(['-i', '/data/take-1.ogg'])
    expect(graph.filterComplex).toContain('[0:a]atrim=start=0:end=10,asetpts=PTS-STARTPTS')
  })

  it('adds one input per unique source and crossfades joins between segments', () => {
    const list = editList({
      segments: [
        { source: 'take-1', start: 0, end: 5 },
        { source: 'take-2', start: 2, end: 8 },
      ],
    })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.inputArgs).toEqual(['-i', '/data/take-1.ogg', '-i', '/data/take-2.ogg'])
    expect(graph.filterComplex).toContain('[1:a]atrim=start=2:end=8')
    expect(graph.filterComplex).toContain('acrossfade=d=0.02')
  })

  it('reuses a single input for a source referenced by multiple segments (punch-in resolution)', () => {
    const list = editList({
      segments: [
        { source: 'take-1', start: 0, end: 5 },
        { source: 'take-2', start: 2, end: 4 },
        { source: 'take-1', start: 4, end: 10 },
      ],
    })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.inputArgs).toEqual(['-i', '/data/take-1.ogg', '-i', '/data/take-2.ogg'])
  })

  it('builds a plain afftdn expression with tn=1 fallback when there is no noise region', () => {
    const list = editList({ filters: [{ type: 'afftdn', nr: 12, gs: 6 }] })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain('afftdn@f0=nr=12:gs=6:tn=1')
    expect(graph.filterComplex).not.toContain('asendcmd')
  })

  it('wires a learned noise profile by priming afftdn with the region prepended, then trimming the prefix back off', () => {
    // afftdn is forward-only: a profile learned via sn start/stop can only clean audio that comes
    // after it in the processed stream. Since the region can sit anywhere in the timeline (in
    // practice, at the tail — after the real content, not before it), the region's own audio is
    // self-extracted from the already-complete chain and concatenated in *front* of it, trained on
    // at [0, duration], then that synthetic prefix is trimmed back off the output. The join itself
    // is a short crossfade (not a hard concat) so the trim point isn't a raw discontinuity.
    const list = editList({ filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 0.2, end: 4.8 } }] })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain('asplit=2[nssrc0][nssplit0]')
    expect(graph.filterComplex).toContain('[nssplit0]atrim=start=0.2:end=4.8,asetpts=PTS-STARTPTS[nstrain0]')
    expect(graph.filterComplex).toContain('[nstrain0][nssrc0]acrossfade=d=0.02[nsprimed0]')
    expect(graph.filterComplex).toContain(
      `asendcmd=c='0-4.6 [enter] afftdn@f0 sn start,[leave] afftdn@f0 sn stop',afftdn@f0=nr=10:gs=6[nsfiltered0]`,
    )
    expect(graph.filterComplex).toContain('[nsfiltered0]atrim=start=4.58,asetpts=PTS-STARTPTS[nstrimmed0]')
    expect(graph.filterComplex).not.toContain(':tn=1')
    expect(graph.outputLabel).toBe('nstrimmed0')
  })

  it('clamps the crossfade to the training duration when the ambience region is shorter than the crossfade window', () => {
    const list = editList({ filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 0, end: 0.01 } }] })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain('[nstrain0][nssrc0]acrossfade=d=0.01[nsprimed0]')
    expect(graph.filterComplex).toContain('[nsfiltered0]atrim=start=0,asetpts=PTS-STARTPTS[nstrimmed0]')
  })

  it('adds a dedicated input for an explicit noise-training source, bypassing self-extraction', () => {
    // The region is captured against the full original take, but editList.segments here is a
    // subset (a crop) of it — self-extracting from the chain itself would grab whatever audio
    // happens to sit at [0.2, 4.8] in the *cropped* render, not the actual ambience sample. An
    // explicit noiseTrainingSource sidesteps that by reading the true span directly from the take.
    // The extra input is read in full and trimmed via atrim (not -ss/-t container seeking), since
    // container-level seeking is unreliable on some formats (e.g. browser-recorded webm).
    const list = editList({ filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 0.2, end: 4.8 } }] })
    const graph = buildFilterGraph(SOURCES, list, {
      noiseTrainingSource: [{ path: '/data/take-1.ogg', start: 20, duration: 4.6 }],
    })
    expect(graph.inputArgs).toEqual(['-i', '/data/take-1.ogg', '-i', '/data/take-1.ogg'])
    expect(graph.filterComplex).not.toContain('asplit')
    expect(graph.filterComplex).toContain('[1:a]atrim=start=20:end=24.6,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[nstrainsrc]')
    expect(graph.filterComplex).toContain('[nstrainsrc][seg0]acrossfade=d=0.02[nsprimed0]')
    expect(graph.filterComplex).toContain(
      `asendcmd=c='0-4.6 [enter] afftdn@f0 sn start,[leave] afftdn@f0 sn stop',afftdn@f0=nr=10:gs=6[nsfiltered0]`,
    )
  })

  it('indexes the training input after all unique segment sources, even with multiple takes', () => {
    const list = editList({
      segments: [
        { source: 'take-1', start: 0, end: 5 },
        { source: 'take-2', start: 0, end: 5 },
      ],
      filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 0, end: 2 } }],
    })
    const graph = buildFilterGraph(SOURCES, list, {
      noiseTrainingSource: [{ path: '/data/take-2.ogg', start: 30, duration: 2 }],
    })
    expect(graph.inputArgs).toEqual(['-i', '/data/take-1.ogg', '-i', '/data/take-2.ogg', '-i', '/data/take-2.ogg'])
    expect(graph.filterComplex).toContain('[2:a]atrim=start=30:end=32,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[nstrainsrc]')
    expect(graph.filterComplex).toContain('[nstrainsrc][cf1]acrossfade=d=0.02[nsprimed0]')
  })

  it('concatenates multiple pieces when the noise-training source spans more than one take', () => {
    // e.g. an ambience selection dragged across a punch-in boundary — the region's audio isn't
    // contiguous in any single take file, so each covered take contributes its own piece and
    // they're stitched together (post-decode, format-normalized) before training on the result.
    const list = editList({ filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 4, end: 8 } }] })
    const graph = buildFilterGraph(SOURCES, list, {
      noiseTrainingSource: [
        { path: '/data/take-1.ogg', start: 40, duration: 2 },
        { path: '/data/take-2.ogg', start: 0, duration: 2 },
      ],
    })
    expect(graph.inputArgs).toEqual([
      '-i', '/data/take-1.ogg',
      '-i', '/data/take-1.ogg', '-i', '/data/take-2.ogg',
    ])
    expect(graph.filterComplex).toContain('[1:a]atrim=start=40:end=42,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[nstrainpiece0]')
    expect(graph.filterComplex).toContain('[2:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[nstrainpiece1]')
    expect(graph.filterComplex).toContain('[nstrainpiece0][nstrainpiece1]concat=n=2:v=0:a=1[nstrainsrc]')
    expect(graph.filterComplex).toContain('[nstrainsrc][seg0]acrossfade=d=0.02[nsprimed0]')
  })

  it('uses a caller-supplied training input instead of self-splitting when one is provided', () => {
    // e.g. a short preview window that isn't guaranteed to contain the region itself — the caller
    // reads the region's audio as a separate input and hands it in by label.
    const list = editList({ filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 20, end: 25 } }] })
    const graph = buildFilterGraph(SOURCES, list, { noiseTrainingLabel: '1:a' })
    expect(graph.filterComplex).not.toContain('asplit')
    expect(graph.filterComplex).toContain('[1:a][seg0]acrossfade=d=0.02[nsprimed0]')
    expect(graph.filterComplex).toContain(
      `asendcmd=c='0-5 [enter] afftdn@f0 sn start,[leave] afftdn@f0 sn stop',afftdn@f0=nr=10:gs=6[nsfiltered0]`,
    )
  })

  it('renders a notch filter as chained high-Q equalizer cuts, one per frequency', () => {
    const list = editList({ filters: [{ type: 'notch', freqs: [50, 100, 150], q: 30 }] })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain('equalizer=f=50:t=q:w=30:g=-24,equalizer=f=100:t=q:w=30:g=-24,equalizer=f=150:t=q:w=30:g=-24')
  })

  it('renders highpass and agate filters', () => {
    const list = editList({ filters: [{ type: 'highpass', freq: 35 }, { type: 'agate', threshold: -50, ratio: 2 }] })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain('highpass=f=35')
    expect(graph.filterComplex).toContain('agate=threshold=-50dB:ratio=2')
  })

  it('appends loudnorm and fade filters', () => {
    const list = editList({
      gain: { mode: 'loudnorm', targetLufs: -16 },
      fades: { inMs: 30, outMs: 1200 },
    })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain('loudnorm=I=-16:TP=-1.5:LRA=11')
    expect(graph.filterComplex).toContain('afade=t=in:d=0.03')
    expect(graph.filterComplex).toContain('afade=t=out:st=8.8:d=1.2')
  })

  it('applies a resolved peak gain as a flat volume filter', () => {
    // Unlike loudnorm, "peak" needs a value measured ahead of time (buildFilterGraph stays pure/
    // synchronous — the measuring pass that produces resolvedPeakGainDb happens in renderEditList).
    const list = editList({ gain: { mode: 'peak', relativeDb: 0 } })
    const graph = buildFilterGraph(SOURCES, list, { resolvedPeakGainDb: 6.5 })
    expect(graph.filterComplex).toContain('volume=6.5dB')
  })

  it('applies no gain filter when a peak gain has not been resolved yet', () => {
    // e.g. a windowed preview that doesn't do the measuring pass — silently skipping rather than
    // throwing means a "Boost to peak" selection doesn't break unrelated quick-audition previews.
    const list = editList({ gain: { mode: 'peak', relativeDb: 0 } })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).not.toContain('volume=')
  })

  it('applies loudnorm after the noise-reduction filters, so afftdn analyzes the original noise floor', () => {
    const list = editList({
      filters: [{ type: 'afftdn', nr: 12, gs: 6 }],
      gain: { mode: 'loudnorm', targetLufs: -16 },
    })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex.indexOf('afftdn@f0')).toBeLessThan(graph.filterComplex.indexOf('loudnorm=I=-16'))
  })

  it('ends the graph on the final label, mapped by the caller', () => {
    const graph = buildFilterGraph(SOURCES, editList({ filters: [{ type: 'highpass', freq: 35 }] }))
    expect(graph.filterComplex).toMatch(new RegExp(`\\[${graph.outputLabel}\\]$`))
  })

  describe('audition mode', () => {
    it('throws when there is no afftdn filter to audition', () => {
      const list = editList({ filters: [{ type: 'highpass', freq: 35 }] })
      expect(() => buildFilterGraph(SOURCES, list, { audition: true })).toThrow('No noise-reduction filter to audition')
    })

    it('outputs only the afftdn link in om=n mode, skipping every other filter, gain and fades', () => {
      const list = editList({
        filters: [
          { type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 0, end: 5 } },
          { type: 'highpass', freq: 35 },
          { type: 'agate', threshold: -50, ratio: 2 },
        ],
        gain: { mode: 'loudnorm', targetLufs: -16 },
        fades: { inMs: 30, outMs: 1200 },
      })
      const graph = buildFilterGraph(SOURCES, list, { audition: true })
      expect(graph.filterComplex).toContain('om=n')
      expect(graph.filterComplex).not.toContain('highpass')
      expect(graph.filterComplex).not.toContain('agate')
      expect(graph.filterComplex).not.toContain('loudnorm')
      expect(graph.filterComplex).not.toContain('afade')
    })
  })
})

describe('buildFiltersOnlyGraph', () => {
  it('applies filters directly to an input label, with no segments involved', () => {
    const graph = buildFiltersOnlyGraph('0:a', [{ type: 'highpass', freq: 35 }])
    expect(graph.inputArgs).toEqual([])
    expect(graph.filterComplex).toBe('[0:a]highpass=f=35[filt0]')
    expect(graph.outputLabel).toBe('filt0')
  })

  it('leaves the output label as the input label when there are no filters', () => {
    const graph = buildFiltersOnlyGraph('0:a', [])
    expect(graph.filterComplex).toBe('')
    expect(graph.outputLabel).toBe('0:a')
  })

  it('applies om=n audition mode over a filters-only graph', () => {
    const graph = buildFiltersOnlyGraph('0:a', [{ type: 'afftdn', nr: 10, gs: 6 }], undefined, { audition: true })
    expect(graph.filterComplex).toContain('om=n')
  })

  it('threads gain through as a post-filter loudnorm step', () => {
    const graph = buildFiltersOnlyGraph('0:a', [{ type: 'highpass', freq: 35 }], { mode: 'loudnorm', targetLufs: -18 })
    expect(graph.filterComplex.indexOf('highpass')).toBeLessThan(graph.filterComplex.indexOf('loudnorm=I=-18'))
  })

  it('applies a resolved peak gain the same way as buildFilterGraph', () => {
    const graph = buildFiltersOnlyGraph('0:a', [], { mode: 'peak', relativeDb: 0 }, { resolvedPeakGainDb: 3 })
    expect(graph.filterComplex).toContain('volume=3dB')
  })
})

describe('resolveNoiseTrainingSource', () => {
  // A single take spanning the whole 0-30s original timeline — the ambience region (10-14s) sits
  // well within it, but well outside whatever a caller's cropped editList.segments might cover.
  const baseSegments = [{ source: 'take-1', start: 0, end: 30 }]

  it('returns undefined when there is no afftdn filter', () => {
    const filters: EditFilter[] = [{ type: 'highpass', freq: 35 }]
    expect(resolveNoiseTrainingSource(filters, baseSegments, SOURCES)).toBeUndefined()
  })

  it('returns undefined when the afftdn filter has no noise region', () => {
    const filters: EditFilter[] = [{ type: 'afftdn', nr: 10, gs: 6 }]
    expect(resolveNoiseTrainingSource(filters, baseSegments, SOURCES)).toBeUndefined()
  })

  it('resolves the region to a take path + local time span', () => {
    const filters: EditFilter[] = [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 10, end: 14 } }]
    expect(resolveNoiseTrainingSource(filters, baseSegments, SOURCES)).toEqual([{
      path: '/data/take-1.ogg',
      start: 10,
      duration: 4,
    }])
  })

  it('splits a region spanning a take boundary into one piece per take', () => {
    // e.g. an ambience selection dragged across a punch-in boundary.
    const segments = [
      { source: 'take-1', start: 0, end: 50 },
      { source: 'take-2', start: 0, end: 50 },
    ]
    const filters: EditFilter[] = [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 48, end: 52 } }]
    expect(resolveNoiseTrainingSource(filters, segments, SOURCES)).toEqual([
      { path: '/data/take-1.ogg', start: 48, duration: 2 },
      { path: '/data/take-2.ogg', start: 0, duration: 2 },
    ])
  })

  it('returns undefined when the region falls outside every base segment', () => {
    const filters: EditFilter[] = [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 100, end: 104 } }]
    expect(resolveNoiseTrainingSource(filters, baseSegments, SOURCES)).toBeUndefined()
  })

  it('returns undefined when the resolved take has no matching source path', () => {
    const filters: EditFilter[] = [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 10, end: 14 } }]
    const segments = [{ source: 'missing-take', start: 0, end: 30 }]
    expect(resolveNoiseTrainingSource(filters, segments, SOURCES)).toBeUndefined()
  })
})
