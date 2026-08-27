import { describe, expect, it } from 'vitest'
import {
  DRUM_CHANNEL,
  assignChannels,
  gmProgramFor,
  instrumentLabel,
  isDrumInstrument,
} from '../../shared/utils/instruments'

describe('gmProgramFor', () => {
  it('maps the MT3 groups to sensible General MIDI programmes', () => {
    expect(gmProgramFor('acoustic_piano')).toBe(0)
    expect(gmProgramFor('electric_bass')).toBe(33)
    expect(gmProgramFor('tenor_sax')).toBe(66)
    expect(gmProgramFor('flutes')).toBe(73)
  })

  it('falls back to piano for an unknown name rather than silence', () => {
    expect(gmProgramFor('kazoo_ensemble')).toBe(0)
  })
})

describe('assignChannels', () => {
  it('puts drums on the GM percussion channel', () => {
    expect(assignChannels(['drums']).get('drums')).toBe(DRUM_CHANNEL)
  })

  it('never assigns channel 9 to a pitched instrument', () => {
    const many = Array.from({ length: 12 }, (_, i) => `inst_${i}`)
    const channels = assignChannels(many)
    for (const [name, ch] of channels) {
      if (name !== 'drums') expect(ch).not.toBe(DRUM_CHANNEL)
    }
  })

  it('gives each distinct instrument its own channel', () => {
    const channels = assignChannels(['acoustic_piano', 'electric_bass', 'drums'])
    expect(new Set(channels.values()).size).toBe(3)
  })

  it('is stable for a repeated instrument', () => {
    const channels = assignChannels(['acoustic_piano', 'acoustic_piano'])
    expect(channels.size).toBe(1)
  })
})

describe('instrumentLabel', () => {
  it('reads as words, not identifiers', () => {
    expect(instrumentLabel('clean_electric_guitar')).toBe('clean electric guitar')
  })
})

describe('isDrumInstrument', () => {
  it('only treats the drums group as percussion', () => {
    expect(isDrumInstrument('drums')).toBe(true)
    expect(isDrumInstrument('timpani')).toBe(false)
  })
})
