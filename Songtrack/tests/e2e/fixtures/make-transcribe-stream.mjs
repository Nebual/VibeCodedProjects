// Regenerates transcribe-stream.jsonl — the canned SSE body MIDI_FAKE_WORKER replays.
// Run with: node tests/e2e/fixtures/make-transcribe-stream.mjs
//
// The frames must be byte-shape-identical to the real sidecar's or the fake tests nothing.
// See plans/AUDIO_TO_MIDI_PLAN_V2.md, "The sidecar's API".
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// Plain `node` resolves this package's CJS `main`; the ESM `module` build is what bundlers pick.
import TonejsMidi from '@tonejs/midi'
const { Midi } = TonejsMidi

const BPM = 120
const ONSET_DELAY = 0.021
const PITCHES = [60, 62, 64, 65, 67, 69, 71, 72] // two 4/4 bars of straight quarter notes
const DUR = 0.5

const notes = PITCHES.map((pitch, i) => ({ pitch, start: i * DUR, end: i * DUR + DUR * 0.9 }))

// Real progress frames are per *chunk* of audio, not per note — a 4-second file yields a single
// {completed:0,total:1} then {completed:1,total:1}. A longer file yields many, which is what this
// fixture models (and what makes the progress bar animate at all).

function midiBase64(quantize) {
  const midi = new Midi()
  midi.header.setTempo(BPM)
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] })
  const track = midi.addTrack()
  track.name = 'acoustic_piano'
  track.instrument.number = 0
  for (const n of notes) {
    track.addNote({
      midi: n.pitch,
      time: n.start,
      duration: quantize ? DUR : n.end - n.start,
      velocity: 0.8,
    })
  }
  return Buffer.from(midi.toArray()).toString('base64')
}

const frames = [{ type: 'progress', completed: 0, total: notes.length }]
notes.forEach((n, i) => {
  // Streamed times run ~21 ms late; the MIDI in the final frame already has that removed.
  frames.push({
    type: 'start',
    pitch: n.pitch,
    start_time: Number((n.start + ONSET_DELAY).toFixed(4)),
    index: i,
    instrument: 'acoustic_piano',
  })
  frames.push({
    type: 'end',
    end_time: Number((n.end + ONSET_DELAY).toFixed(4)),
    start_event_index: i,
  })
  frames.push({ type: 'progress', completed: i + 1, total: notes.length })
})
// Shaped to match a *live* 0.3.0 sidecar, verified against one:
//  - `quantized_midi` is absent entirely, not null.
//  - `beats_per_bar` is null even when a bpm is detected, so the stub exercises the defaulting
//    in beatGridFromWire rather than pretending upstream fills it in.
frames.push({
  type: 'transcription_complete',
  data: midiBase64(false),
  beat_grid: { bpm: BPM, beats_per_bar: null, first_downbeat: 0, onset_delay: ONSET_DELAY },
})

const out = join(dirname(fileURLToPath(import.meta.url)), 'transcribe-stream.jsonl')
writeFileSync(out, frames.map(f => JSON.stringify(f)).join('\n') + '\n')
console.log(`wrote ${frames.length} frames to ${out}`)
