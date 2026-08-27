import { describe, expect, it } from 'vitest'
import { normalizeYoutubeUrl, parseYoutubeUrls } from '../../shared/utils/youtube'

describe('parseYoutubeUrls', () => {
  it('splits on newlines and trims each line', () => {
    expect(parseYoutubeUrls(' https://youtu.be/aaaaaaaaaaa \n\thttps://youtu.be/bbbbbbbbbbb\t'))
      .toEqual(['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'])
  })

  it('ignores blank lines and whitespace-only lines', () => {
    expect(parseYoutubeUrls('https://youtu.be/aaaaaaaaaaa\n\n   \n\nhttps://youtu.be/bbbbbbbbbbb'))
      .toEqual(['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'])
  })

  it('handles \\r\\n line endings from a Windows paste', () => {
    expect(parseYoutubeUrls('https://youtu.be/aaaaaaaaaaa\r\nhttps://youtu.be/bbbbbbbbbbb'))
      .toEqual(['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'])
  })

  it('splits on spaces too, so a space-separated paste still works', () => {
    expect(parseYoutubeUrls('https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb'))
      .toEqual(['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'])
  })

  it('deduplicates repeated urls, keeping first-seen order', () => {
    expect(parseYoutubeUrls([
      'https://youtu.be/bbbbbbbbbbb',
      'https://youtu.be/aaaaaaaaaaa',
      'https://youtu.be/bbbbbbbbbbb',
    ].join('\n'))).toEqual(['https://youtu.be/bbbbbbbbbbb', 'https://youtu.be/aaaaaaaaaaa'])
  })

  it('deduplicates across url forms that resolve to the same video', () => {
    expect(parseYoutubeUrls([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
    ].join('\n'))).toEqual(['https://www.youtube.com/watch?v=dQw4w9WgXcQ'])
  })

  it('returns an empty list for empty or whitespace-only input', () => {
    expect(parseYoutubeUrls('')).toEqual([])
    expect(parseYoutubeUrls('   \n \n')).toEqual([])
  })
})

describe('normalizeYoutubeUrl', () => {
  it('accepts a standard watch url and keeps the video id', () => {
    expect(normalizeYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toEqual({ ok: true, videoId: 'dQw4w9WgXcQ' })
  })

  it('accepts the short youtu.be form', () => {
    expect(normalizeYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'))
      .toEqual({ ok: true, videoId: 'dQw4w9WgXcQ' })
  })

  it.each([
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ])('accepts %s', (url) => {
    expect(normalizeYoutubeUrl(url)).toEqual({ ok: true, videoId: 'dQw4w9WgXcQ' })
  })

  it('accepts a url missing its scheme, assuming https', () => {
    expect(normalizeYoutubeUrl('youtu.be/dQw4w9WgXcQ'))
      .toEqual({ ok: true, videoId: 'dQw4w9WgXcQ' })
  })

  it('keeps the video id from a watch url that also carries a playlist', () => {
    expect(normalizeYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4'))
      .toEqual({ ok: true, videoId: 'dQw4w9WgXcQ' })
  })

  it('rejects a bare playlist url, which names no single video', () => {
    const result = normalizeYoutubeUrl('https://www.youtube.com/playlist?list=PL1234567890')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/playlist/i)
  })

  it('rejects a channel url', () => {
    expect(normalizeYoutubeUrl('https://www.youtube.com/@someartist').ok).toBe(false)
  })

  it.each([
    'https://vimeo.com/12345',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    // Host that merely ends with the allowlisted string must not slip through.
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
  ])('rejects non-youtube host %s', (url) => {
    const result = normalizeYoutubeUrl(url)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/youtube/i)
  })

  it('rejects non-http schemes', () => {
    expect(normalizeYoutubeUrl('file:///etc/passwd').ok).toBe(false)
    expect(normalizeYoutubeUrl('ftp://youtube.com/watch?v=dQw4w9WgXcQ').ok).toBe(false)
  })

  it('rejects a shell-injection-looking string outright rather than passing it on', () => {
    expect(normalizeYoutubeUrl('https://youtu.be/abc; rm -rf /').ok).toBe(false)
  })

  it('rejects garbage that is not a url at all', () => {
    expect(normalizeYoutubeUrl('not a url').ok).toBe(false)
    expect(normalizeYoutubeUrl('').ok).toBe(false)
  })

  it('rejects an id of the wrong length', () => {
    expect(normalizeYoutubeUrl('https://youtu.be/tooshort').ok).toBe(false)
  })
})

