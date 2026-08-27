import { Midi } from '@tonejs/midi'
import type { BeatGrid, TranscribedNote } from '../../shared/types'
import { scoreLayout } from './quantize'
import { DRUM_CHANNEL, gmProgramFor, isDrumInstrument } from '../../shared/utils/instruments'

/**
 * Reads note events back out of a MIDI file.
 *
 * This — not the streamed `start`/`end` frames — is the authoritative source for `events.json`.
 * The streamed times run up to ~25 ms late, while the MIDI in the final frame already has that
 * lag removed, so deriving events from the file keeps the lag correction in exactly one place
 * (upstream's) instead of re-implementing it here from `onset_delay`.
 */
export function notesFromMidi(buffer: Buffer): TranscribedNote[] {
  const midi = new Midi(new Uint8Array(buffer).buffer as ArrayBuffer)
  const notes: TranscribedNote[] = []

  for (const track of midi.tracks) {
    const instrument = trackInstrument(track)
    for (const note of track.notes) {
      notes.push({
        pitch: note.midi,
        start: note.time,
        end: note.time + note.duration,
        instrument,
      })
    }
  }

  // Ordering is not guaranteed across tracks, and everything downstream (the roll, the
  // quantizer, the score writer) assumes onset order.
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return notes
}

/** MuScriptor names its tracks after the MT3 instrument group; fall back to the GM family. */
function trackInstrument(track: Midi['tracks'][number]): string {
  if (track.channel === 9) return 'drums'
  const name = track.name?.trim()
  if (name) return name
  return track.instrument?.family || track.instrument?.name || 'piano'
}

/**
 * Writes quantized notes out as a *score* MIDI — the file to hand to MuseScore, Sibelius or
 * anything else that has to divide onsets into notated durations.
 *
 * Both meta events matter for import, and for different reasons: without a tempo the notated
 * durations come out at whatever default the importer assumes, and **without a time signature
 * MuseScore assumes 4/4 regardless of what the notes imply**.
 */
export function writeScoreMidi(notes: TranscribedNote[], grid: BeatGrid): Buffer {
  const midi = new Midi()
  midi.header.setTempo(grid.bpm)
  midi.header.timeSignatures.length = 0

  // A beat is always a quarter note here, so the signature is beatsPerBar/4. Choosing 6/8 for
  // compound time would redefine what `bpm` counts and desync every other consumer of the grid
  // (the roll overlay, barLines, onsetError) for a purely cosmetic gain.
  // A score has no absolute time, only positions relative to barlines, so the sub-beat part of
  // firstDownbeat is absorbed by moving the notes. See scoreLayout() for why emitting it as a
  // meter instead corrupts the engraving.
  const earliest = notes.length ? Math.min(...notes.map(n => n.start)) : 0
  const { pickupBeats, shift } = scoreLayout(grid, earliest)

  if (pickupBeats > 0) {
    // Same beat unit as the main meter — a 3-beat anacrusis in 4/4 is 3/4, not 12/16. MuseScore
    // handles the former and mangles the latter.
    midi.header.timeSignatures.push({ ticks: 0, timeSignature: [pickupBeats, 4] })
    midi.header.timeSignatures.push({
      ticks: Math.round(midi.header.secondsToTicks(pickupBeats * (60 / grid.bpm))),
      timeSignature: [grid.beatsPerBar, 4],
    })
  }
  else {
    midi.header.timeSignatures.push({ ticks: 0, timeSignature: [grid.beatsPerBar, 4] })
  }

  // One track per instrument keeps the parts separable — the sheets archive gets one PDF each.
  const byInstrument = new Map<string, TranscribedNote[]>()
  for (const note of notes) {
    const list = byInstrument.get(note.instrument)
    if (list) list.push(note)
    else byInstrument.set(note.instrument, [note])
  }

  // Durations are stored as integer ticks, so any floor below one tick still rounds to a
  // zero-length note. `quantizeNotes` already guarantees a full grid step; this is the backstop
  // for callers handing over raw, unquantized events.
  const minDuration = midi.header.ticksToSeconds(1)

  for (const [instrument, group] of byInstrument) {
    const track = midi.addTrack()
    track.name = instrument
    // Without a programme every part imports and plays back as piano, which makes a
    // multi-instrument transcription useless as an audio check and wrong on the page.
    if (isDrumInstrument(instrument)) {
      track.channel = DRUM_CHANNEL
    }
    else {
      track.instrument.number = gmProgramFor(instrument)
    }
    for (const note of group) {
      track.addNote({
        midi: note.pitch,
        time: Math.max(0, note.start + shift),
        duration: Math.max(minDuration, note.end - note.start),
        // The tokenizer doesn't recover velocity at all, so a flat mezzo-forte is the honest
        // choice — anything else would be inventing dynamics that were never transcribed.
        velocity: 0.7,
      })
    }
  }

  // A completely empty transcription still has to produce a valid file rather than throw.
  if (midi.tracks.length === 0) midi.addTrack().name = 'empty'

  return Buffer.from(midi.toArray())
}

/**
 * Moves every note in a MIDI file earlier by `seconds`, leaving the rest of the file alone.
 *
 * Used to undo the silence `postAudio` prepends: the stored performance MIDI has to line up with
 * the user's actual recording, and re-writing the file from scratch would throw away upstream's
 * own tempo and meta events for no reason. Notes that would land before zero are clamped there
 * rather than dropped — losing a note to arithmetic would be worse than a few milliseconds of
 * error on one that started during the pad.
 */
export function shiftMidiNotes(buffer: Buffer, seconds: number): Buffer {
  if (!seconds) return buffer
  const midi = new Midi(new Uint8Array(buffer).buffer as ArrayBuffer)
  for (const track of midi.tracks) {
    for (const note of track.notes) note.time = Math.max(0, note.time - seconds)
  }
  return Buffer.from(midi.toArray())
}
