import { createReadStream, statSync } from 'node:fs'
import type { H3Event } from 'h3'

export function streamRangeableFile(event: H3Event, path: string, contentType: string) {
  const stat = statSync(path)
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Content-Type', contentType)

  const range = getHeader(event, 'range')
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match?.[1] ? Number.parseInt(match[1], 10) : 0
    const end = match?.[2] ? Number.parseInt(match[2], 10) : stat.size - 1
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${stat.size}`)
    setHeader(event, 'Content-Length', end - start + 1)
    return sendStream(event, createReadStream(path, { start, end }))
  }

  setHeader(event, 'Content-Length', stat.size)
  return sendStream(event, createReadStream(path))
}
