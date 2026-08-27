import { describe, expect, it } from 'vitest'
import { MAX_IMPORT_DURATION_S, buildYtDlpArgs, parseYtDlpStdout, summarizeYtDlpError } from '../../server/utils/ytdlp'

describe('buildYtDlpArgs', () => {
  const opts = { videoId: 'dQw4w9WgXcQ', outputTemplate: '/data/takes/take1.%(ext)s' }

  it('downloads the best audio-only stream, falling back to best', () => {
    const args = buildYtDlpArgs(opts)
    expect(args).toContain('-f')
    expect(args[args.indexOf('-f') + 1]).toBe('bestaudio/best')
  })

  it('passes the canonical watch url built from the video id, never raw user text', () => {
    expect(buildYtDlpArgs(opts)).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  })

  it('never expands a playlist', () => {
    expect(buildYtDlpArgs(opts)).toContain('--no-playlist')
  })

  it('prints the title and the final on-disk path, in that order', () => {
    const args = buildYtDlpArgs(opts)
    const prints = args.reduce<string[]>((acc, arg, i) => {
      if (arg === '--print') acc.push(args[i + 1]!)
      return acc
    }, [])
    expect(prints).toEqual(['title', 'after_move:filepath'])
  })

  it('uses the caller output template so the file lands in the song take dir', () => {
    const args = buildYtDlpArgs(opts)
    expect(args[args.indexOf('-o') + 1]).toBe('/data/takes/take1.%(ext)s')
  })

  it('caps duration with the allow-missing form, so a video with unknown duration still imports', () => {
    const args = buildYtDlpArgs(opts)
    const filter = args[args.indexOf('--match-filter') + 1]
    expect(filter).toBe(`duration<?${MAX_IMPORT_DURATION_S}`)
  })

  it('respects a caller-supplied duration cap', () => {
    const args = buildYtDlpArgs({ ...opts, maxDurationS: 90 })
    expect(args[args.indexOf('--match-filter') + 1]).toBe('duration<?90')
  })

  it('suppresses progress output so stdout carries only the --print lines', () => {
    expect(buildYtDlpArgs(opts)).toContain('--no-progress')
  })

  it('never disables certificate validation', () => {
    expect(buildYtDlpArgs(opts)).not.toContain('--no-check-certificates')
  })
})

describe('parseYtDlpStdout', () => {
  it('reads the title and path from the two printed lines', () => {
    expect(parseYtDlpStdout('Never Gonna Give You Up\n/data/takes/take1.webm\n'))
      .toEqual({ title: 'Never Gonna Give You Up', filePath: '/data/takes/take1.webm' })
  })

  it('tolerates a title containing whitespace and punctuation', () => {
    expect(parseYtDlpStdout('  A Song - Live (2019)  \n/data/takes/t.m4a'))
      .toEqual({ title: 'A Song - Live (2019)', filePath: '/data/takes/t.m4a' })
  })

  it('returns null when nothing was printed — yt-dlp exits 0 when --match-filter skips a video', () => {
    expect(parseYtDlpStdout('')).toBeNull()
    expect(parseYtDlpStdout('\n \n')).toBeNull()
  })

  it('returns null when only the title was printed and the download never produced a file', () => {
    expect(parseYtDlpStdout('Some Title\n')).toBeNull()
  })

  it('takes the last two non-empty lines, ignoring any extra chatter above them', () => {
    expect(parseYtDlpStdout('[youtube] noise\nReal Title\n/data/takes/t.opus'))
      .toEqual({ title: 'Real Title', filePath: '/data/takes/t.opus' })
  })

  it('treats "NA" (yt-dlp\'s placeholder for a missing field) as no title', () => {
    expect(parseYtDlpStdout('NA\n/data/takes/t.webm'))
      .toEqual({ title: '', filePath: '/data/takes/t.webm' })
  })
})

describe('summarizeYtDlpError', () => {
  // Verbatim stderr captured from yt-dlp nightly, not invented.
  it('strips the ERROR prefix and the extractor tag', () => {
    const stderr = 'ERROR: [generic] nope: Unable to download webpage: HTTP Error 404: File not found (caused by <HTTPError 404: File not found>)'
    expect(summarizeYtDlpError(stderr))
      .toBe('nope: Unable to download webpage: HTTP Error 404: File not found (caused by <HTTPError 404: File not found>)')
  })

  it('drops the "please report this issue" boilerplate yt-dlp appends', () => {
    const stderr = 'ERROR: [youtube] dQw4w9WgXcQ: Failed to extract any player response; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U'
    expect(summarizeYtDlpError(stderr)).toBe('dQw4w9WgXcQ: Failed to extract any player response')
  })

  it('picks the last ERROR line, ignoring the WARNING retries above it', () => {
    const stderr = [
      'WARNING: [youtube] [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed. Retrying (1/3)...',
      'ERROR: [youtube] abc: Video unavailable',
    ].join('\n')
    expect(summarizeYtDlpError(stderr)).toBe('abc: Video unavailable')
  })

  it('falls back to a generic message when stderr carries no ERROR line', () => {
    expect(summarizeYtDlpError('WARNING: something odd\n')).toBe('The download failed.')
    expect(summarizeYtDlpError('')).toBe('The download failed.')
  })
})
