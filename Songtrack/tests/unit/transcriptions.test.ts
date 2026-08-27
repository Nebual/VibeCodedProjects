import { describe, expect, it } from 'vitest'
import {
  SseParser,
  beatGridFromWire,
  gridHash,
  transcriptionSpecHash,
} from '../../server/utils/transcriptions'
import type { BeatGrid } from '../../shared/types'

const GRID: BeatGrid = {
  bpm: 120,
  beatsPerBar: 4,
  firstDownbeat: 0.5,
  onsetDelay: 0.021,
  subdivision: 4,
}

describe('transcriptionSpecHash', () => {
  it('is stable for identical inputs', () => {
    const a = transcriptionSpecHash('/d/master.ogg', 1000, 'small', ['piano'])
    const b = transcriptionSpecHash('/d/master.ogg', 1000, 'small', ['piano'])
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('ignores instrument order so the cache is not order-sensitive', () => {
    expect(transcriptionSpecHash('/d/m.ogg', 1, 'small', ['drums', 'piano']))
      .toBe(transcriptionSpecHash('/d/m.ogg', 1, 'small', ['piano', 'drums']))
  })

  it('changes when the master is re-rendered (mtime moves)', () => {
    expect(transcriptionSpecHash('/d/m.ogg', 1, 'small', ['piano']))
      .not.toBe(transcriptionSpecHash('/d/m.ogg', 2, 'small', ['piano']))
  })

  it('changes with the model, so a re-run at a bigger model is not served from cache', () => {
    expect(transcriptionSpecHash('/d/m.ogg', 1, 'small', ['piano']))
      .not.toBe(transcriptionSpecHash('/d/m.ogg', 1, 'large', ['piano']))
  })

  it('distinguishes an empty instrument list (auto-detect) from an explicit one', () => {
    expect(transcriptionSpecHash('/d/m.ogg', 1, 'small', []))
      .not.toBe(transcriptionSpecHash('/d/m.ogg', 1, 'small', ['piano']))
  })
})

describe('gridHash', () => {
  it('is stable and short', () => {
    expect(gridHash(GRID)).toBe(gridHash({ ...GRID }))
    expect(gridHash(GRID)).toHaveLength(12)
  })

  it('rounds away float noise from a dragged slider', () => {
    expect(gridHash({ ...GRID, bpm: 120.00001 })).toBe(gridHash(GRID))
    expect(gridHash({ ...GRID, firstDownbeat: 0.500001 })).toBe(gridHash(GRID))
  })

  it('still separates a genuinely different tempo', () => {
    expect(gridHash({ ...GRID, bpm: 60 })).not.toBe(gridHash(GRID))
    expect(gridHash({ ...GRID, beatsPerBar: 3 })).not.toBe(gridHash(GRID))
    expect(gridHash({ ...GRID, subdivision: 2 })).not.toBe(gridHash(GRID))
  })

  it('ignores onsetDelay, which does not affect the engraving', () => {
    expect(gridHash({ ...GRID, onsetDelay: 0.5 })).toBe(gridHash(GRID))
  })
})

describe('beatGridFromWire', () => {
  it('converts snake_case to camelCase and supplies a default subdivision', () => {
    expect(beatGridFromWire({
      bpm: 92.4, beats_per_bar: 4, first_downbeat: 0.31, onset_delay: 0.021,
    })).toEqual({
      bpm: 92.4, beatsPerBar: 4, firstDownbeat: 0.31, onsetDelay: 0.021, subdivision: 4,
    })
  })

  it('passes through a missing grid as null', () => {
    expect(beatGridFromWire(null)).toBeNull()
    expect(beatGridFromWire(undefined)).toBeNull()
  })

  // Everything below was found by running against a real sidecar, not by reading the plan.
  it('defaults a null beats_per_bar to 4, which a live sidecar sends alongside a valid bpm', () => {
    const grid = beatGridFromWire({
      bpm: 120.00000000000003, beats_per_bar: null, first_downbeat: 0, onset_delay: 0,
    })
    // Left as null this reaches the score writer as a [null, 4] time signature and the piano
    // roll as a NaN bar width.
    expect(grid).toMatchObject({ beatsPerBar: 4 })
    expect(grid!.bpm).toBeCloseTo(120, 6)
  })

  it('rounds away the detector\'s float noise on bpm', () => {
    // A real sidecar reports 120.00000000000003 for a clean 120 bpm.
    expect(beatGridFromWire({
      bpm: 120.00000000000003, beats_per_bar: 4, first_downbeat: 0, onset_delay: 0,
    })!.bpm).toBe(120)
    // Genuinely fractional tempos survive.
    expect(beatGridFromWire({
      bpm: 92.4567, beats_per_bar: 4, first_downbeat: 0, onset_delay: 0,
    })!.bpm).toBe(92.457)
  })

  it('treats an unusable bpm as no grid at all rather than inventing one', () => {
    expect(beatGridFromWire({ bpm: null, beats_per_bar: 4, first_downbeat: 0, onset_delay: 0 })).toBeNull()
    expect(beatGridFromWire({ bpm: 0, beats_per_bar: 4, first_downbeat: 0, onset_delay: 0 })).toBeNull()
    expect(beatGridFromWire({ bpm: Number.NaN, beats_per_bar: 4, first_downbeat: 0, onset_delay: 0 })).toBeNull()
  })

  it('defaults null timing fields to zero', () => {
    expect(beatGridFromWire({ bpm: 90, beats_per_bar: 3, first_downbeat: null, onset_delay: null }))
      .toMatchObject({ firstDownbeat: 0, onsetDelay: 0, beatsPerBar: 3 })
  })
})

describe('the transcription_complete frame as a live sidecar actually sends it', () => {
  it('parses a frame with no quantized_midi key at all', () => {
    const p = new SseParser()
    // Verified shape: the key is absent, not null. Indexing it without a guard yields undefined.
    const frame = {
      type: 'transcription_complete',
      data: 'TVRoZA==',
      beat_grid: { bpm: 120.00000000000003, beats_per_bar: null, first_downbeat: 0.0, onset_delay: 0.0 },
    }
    const [parsed] = p.push(`data: ${JSON.stringify(frame)}\n\n`)
    expect(parsed).toEqual(frame)
    expect((parsed as { quantized_midi?: string }).quantized_midi).toBeUndefined()
  })

  it('parses the sidecar\'s spaced JSON, not just compact JSON', () => {
    const p = new SseParser()
    // Upstream emits `{"type": "progress", ...}` with spaces after the colons.
    expect(p.push('data: {"type": "progress", "completed": 0, "total": 1}\n\n'))
      .toEqual([{ type: 'progress', completed: 0, total: 1 }])
  })
})

describe('SseParser', () => {
  it('parses one whole frame', () => {
    const p = new SseParser()
    expect(p.push('data: {"type":"progress","completed":3,"total":48}\n\n'))
      .toEqual([{ type: 'progress', completed: 3, total: 48 }])
  })

  it('holds a frame split across chunk boundaries until it is complete', () => {
    const p = new SseParser()
    expect(p.push('data: {"type":"prog')).toEqual([])
    expect(p.push('ress","completed":1,"tot')).toEqual([])
    expect(p.push('al":2}\n')).toEqual([{ type: 'progress', completed: 1, total: 2 }])
  })

  it('splits a chunk carrying several frames at once', () => {
    const p = new SseParser()
    const events = p.push(
      'data: {"type":"start","pitch":60,"start_time":1.25,"index":17,"instrument":"acoustic_piano"}\n'
      + 'data: {"type":"end","end_time":1.9,"start_event_index":17}\n',
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'start', pitch: 60, index: 17 })
    expect(events[1]).toMatchObject({ type: 'end', start_event_index: 17 })
  })

  it('handles a frame that arrives one byte at a time', () => {
    const p = new SseParser()
    const frame = 'data: {"type":"end","end_time":2,"start_event_index":4}\n'
    const seen = [...frame].flatMap(c => p.push(c))
    expect(seen).toEqual([{ type: 'end', end_time: 2, start_event_index: 4 }])
  })

  it('ignores blank lines, comments and non-data fields', () => {
    const p = new SseParser()
    expect(p.push('\n: keepalive\nevent: message\n\n')).toEqual([])
  })

  it('survives a malformed frame without dropping the ones around it', () => {
    const p = new SseParser()
    const events = p.push(
      'data: {"type":"progress","completed":1,"total":2}\n'
      + 'data: {not json\n'
      + 'data: {"type":"progress","completed":2,"total":2}\n',
    )
    expect(events).toEqual([
      { type: 'progress', completed: 1, total: 2 },
      { type: 'progress', completed: 2, total: 2 },
    ])
  })

  it('tolerates CRLF line endings', () => {
    const p = new SseParser()
    expect(p.push('data: {"type":"progress","completed":1,"total":2}\r\n\r\n'))
      .toEqual([{ type: 'progress', completed: 1, total: 2 }])
  })

  it('flush() yields a trailing frame that never got its newline', () => {
    const p = new SseParser()
    expect(p.push('data: {"type":"progress","completed":9,"total":9}')).toEqual([])
    expect(p.flush()).toEqual([{ type: 'progress', completed: 9, total: 9 }])
    expect(p.flush()).toEqual([])
  })

  it('carries the large transcription_complete payload through intact', () => {
    const p = new SseParser()
    const frame = {
      type: 'transcription_complete',
      data: 'TVRoZA==',
      quantized_midi: null,
      beat_grid: { bpm: 92.4, beats_per_bar: 4, first_downbeat: 0.31, onset_delay: 0.021 },
    }
    const raw = `data: ${JSON.stringify(frame)}\n`
    // Split at an arbitrary offset inside the base64 blob.
    const cut = Math.floor(raw.length / 2)
    p.push(raw.slice(0, cut))
    expect(p.push(raw.slice(cut))).toEqual([frame])
  })
})
