/**
 * MuScriptor's MT3 instrument groups → General MIDI programme numbers.
 *
 * Used in two places that must agree: the score MIDI written server-side, and the in-browser
 * synth. Without it every part is written as programme 0 — so a bass line, a sax and a drum kit
 * all come back as piano, which makes the audio check useless for anything but solo piano.
 *
 * Names are the exact strings the sidecar's `GET /instruments` returns.
 */
const GM_PROGRAMS: Record<string, number> = {
  acoustic_piano: 0,
  electric_piano: 4,
  chromatic_percussion: 11,
  organ: 16,
  acoustic_guitar: 24,
  clean_electric_guitar: 27,
  distorted_electric_guitar: 30,
  acoustic_bass: 32,
  electric_bass: 33,
  violin: 40,
  viola: 41,
  cello: 42,
  contrabass: 43,
  orchestral_harp: 46,
  timpani: 47,
  string_ensemble: 48,
  synth_strings: 50,
  voice: 52,
  orchestra_hit: 55,
  trumpet: 56,
  trombone: 57,
  tuba: 58,
  french_horn: 60,
  brass_section: 61,
  soprano_and_alto_sax: 65,
  tenor_sax: 66,
  baritone_sax: 67,
  oboe: 68,
  english_horn: 69,
  bassoon: 70,
  clarinet: 71,
  flutes: 73,
  synth_lead: 80,
  synth_pad: 88,
}

/** The GM percussion channel. Anything on it is a drum kit regardless of programme. */
export const DRUM_CHANNEL = 9

export function isDrumInstrument(instrument: string): boolean {
  return instrument === 'drums'
}

/** Falls back to piano for a name we don't know — a wrong timbre beats a silent part. */
export function gmProgramFor(instrument: string): number {
  return GM_PROGRAMS[instrument] ?? 0
}

/** "clean_electric_guitar" → "clean electric guitar", for chips and track labels. */
export function instrumentLabel(instrument: string): string {
  return instrument.replace(/_/g, ' ')
}

/**
 * Assigns a MIDI channel per instrument. Drums always take channel 9 (GM percussion), everything
 * else takes the next free non-percussion channel; past 15 channels we wrap, since a transcription
 * with 16 distinct instrument groups sharing timbres is better than one that drops parts entirely.
 */
export function assignChannels(instruments: string[]): Map<string, number> {
  const channels = new Map<string, number>()
  let next = 0
  for (const instrument of instruments) {
    if (channels.has(instrument)) continue
    if (isDrumInstrument(instrument)) {
      channels.set(instrument, DRUM_CHANNEL)
      continue
    }
    if (next === DRUM_CHANNEL) next++
    channels.set(instrument, next % 16)
    next++
  }
  return channels
}
