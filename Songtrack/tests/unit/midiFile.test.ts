import { describe, expect, it } from 'vitest'
import { Midi } from '@tonejs/midi'
import { notesFromMidi, writeScoreMidi } from '../../server/utils/midiFile'
import { quantizeNotes } from '../../server/utils/quantize'
import type { BeatGrid, TranscribedNote } from '../../shared/types'

const GRID: BeatGrid = {
  bpm: 120, beatsPerBar: 4, firstDownbeat: 0, onsetDelay: 0, subdivision: 4,
}

function scale(): TranscribedNote[] {
  return [60, 62, 64, 65].map((pitch, i) => ({
    pitch, start: i * 0.5, end: i * 0.5 + 0.45, instrument: 'acoustic_piano',
  }))
}

describe('writeScoreMidi / notesFromMidi round trip', () => {
  it('produces a real MIDI file', () => {
    const buf = writeScoreMidi(scale(), GRID)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('MThd')
  })

  it('preserves pitches and times through a round trip', () => {
    const notes = quantizeNotes(scale(), GRID)
    const read = notesFromMidi(writeScoreMidi(notes, GRID))
    expect(read.map(n => n.pitch)).toEqual([60, 62, 64, 65])
    read.forEach((n, i) => expect(n.start).toBeCloseTo(notes[i]!.start, 3))
  })

  it('carries the tempo, so an importer does not guess one', () => {
    const midi = new Midi(toArrayBuffer(writeScoreMidi(scale(), { ...GRID, bpm: 92.4 })))
    expect(midi.header.tempos[0]!.bpm).toBeCloseTo(92.4, 2)
  })

  it('carries a time signature — without one MuseScore assumes 4/4 whatever the notes imply', () => {
    const midi = new Midi(toArrayBuffer(writeScoreMidi(scale(), { ...GRID, beatsPerBar: 3 })))
    expect(midi.header.timeSignatures[0]!.timeSignature).toEqual([3, 4])
  })

  it('emits a short opening bar as a pickup, then switches to the real signature', () => {
    // firstDownbeat 1.5s at 120bpm = 3 beats in → a 3-beat (12/16) anacrusis.
    const grid = { ...GRID, firstDownbeat: 1.5 }
    const midi = new Midi(toArrayBuffer(writeScoreMidi(quantizeNotes(scale(), grid), grid)))
    expect(midi.header.timeSignatures).toHaveLength(2)
    expect(midi.header.timeSignatures[0]).toMatchObject({ ticks: 0, timeSignature: [12, 16] })
    expect(midi.header.timeSignatures[1]!.timeSignature).toEqual([4, 4])
    expect(midi.header.timeSignatures[1]!.ticks).toBeGreaterThan(0)
  })

  it('uses a single time signature when the music starts on a downbeat', () => {
    const midi = new Midi(toArrayBuffer(writeScoreMidi(scale(), GRID)))
    expect(midi.header.timeSignatures).toHaveLength(1)
  })

  it('splits instruments into separate tracks, with drums on channel 9', () => {
    const notes: TranscribedNote[] = [
      { pitch: 60, start: 0, end: 0.5, instrument: 'acoustic_piano' },
      { pitch: 38, start: 0, end: 0.1, instrument: 'drums' },
    ]
    const midi = new Midi(toArrayBuffer(writeScoreMidi(notes, GRID)))
    expect(midi.tracks).toHaveLength(2)
    const drums = midi.tracks.find(t => t.name === 'drums')
    expect(drums?.channel).toBe(9)
    expect(notesFromMidi(writeScoreMidi(notes, GRID)).map(n => n.instrument).sort())
      .toEqual(['acoustic_piano', 'drums'])
  })

  it('writes a valid file for an empty transcription rather than throwing', () => {
    const buf = writeScoreMidi([], GRID)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('MThd')
    expect(notesFromMidi(buf)).toEqual([])
  })

  it('never emits a zero-length note', () => {
    const notes = [{ pitch: 60, start: 1, end: 1, instrument: 'acoustic_piano' }]
    const read = notesFromMidi(writeScoreMidi(notes, GRID))
    expect(read[0]!.end).toBeGreaterThan(read[0]!.start)
  })
})

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return new Uint8Array(buf).buffer as ArrayBuffer
}
