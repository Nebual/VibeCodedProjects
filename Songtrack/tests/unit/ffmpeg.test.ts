import { describe, expect, it } from 'vitest'
import { buildFilterGraph, buildFiltersOnlyGraph } from '../../server/utils/ffmpeg'
import type { EditList } from '../../shared/types'

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

  it('wires a learned noise profile via asendcmd sn start/stop when a noise region is given', () => {
    const list = editList({ filters: [{ type: 'afftdn', nr: 10, gs: 6, noiseRegion: { start: 0.2, end: 4.8 } }] })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex).toContain(
      `asendcmd=c='0.2-4.8 [enter] afftdn@f0 sn start,[leave] afftdn@f0 sn stop',afftdn@f0=nr=10:gs=6[filt0]`,
    )
    expect(graph.filterComplex).not.toContain(':tn=1')
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

  it('applies loudnorm before the noise-reduction filters, so afftdn analyzes properly-leveled audio', () => {
    const list = editList({
      filters: [{ type: 'afftdn', nr: 12, gs: 6 }],
      gain: { mode: 'loudnorm', targetLufs: -16 },
    })
    const graph = buildFilterGraph(SOURCES, list)
    expect(graph.filterComplex.indexOf('loudnorm=I=-16')).toBeLessThan(graph.filterComplex.indexOf('afftdn@f0'))
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

  it('threads gain through as a pre-filter loudnorm step', () => {
    const graph = buildFiltersOnlyGraph('0:a', [{ type: 'highpass', freq: 35 }], { mode: 'loudnorm', targetLufs: -18 })
    expect(graph.filterComplex.indexOf('loudnorm=I=-18')).toBeLessThan(graph.filterComplex.indexOf('highpass'))
  })
})
